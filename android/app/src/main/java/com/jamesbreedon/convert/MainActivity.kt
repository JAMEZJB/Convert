package com.jamesbreedon.convert

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import java.io.IOException
import java.io.OutputStream

/**
 * Convert to it! — Android wrapper.
 *
 * This is a thin WebView shell around the SAME Vite bundle the desktop (Electron) build
 * serves — see the repo-root README's "Android" section for how it's built. The upstream
 * UI is not modified in any way; the only app code here is this activity plus the tiny
 * download bridge below (AndroidDownloader).
 *
 * The bundle is served from app assets (assets/convert/, copied from dist/ at build time)
 * through WebViewAssetLoader at https://appassets.androidplatform.net/convert/…, which is
 * what the Vite `base: "/convert/"` config expects. Every response gets the same
 * Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers the desktop's Electron
 * protocol handler (src/electron.cjs) injects, so the SharedArrayBuffer-dependent wasm
 * converters (ffmpeg, sqlite, etc.) keep working.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = pendingFileChooserCallback
            pendingFileChooserCallback = null
            if (callback == null) return@registerForActivityResult

            val data = result.data
            if (result.resultCode != RESULT_OK || data == null) {
                callback.onReceiveValue(null)
                return@registerForActivityResult
            }

            val uris = mutableListOf<Uri>()
            data.clipData?.let { clip ->
                for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
            }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }

            callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        }

    private var pendingFileChooserCallback: android.webkit.ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/convert/", ConvertAssetsPathHandler())
            .build()

        webView = WebView(this)
        setContentView(webView)

        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // Defaults on modern API levels, but pinned explicitly: nothing here is ever
            // loaded from file:// and the asset loader is the only content source.
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
        }

        webView.addJavascriptInterface(AndroidDownloader(), "AndroidDownloader")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val response = assetLoader.shouldInterceptRequest(request.url) ?: return null
                val headers = HashMap(response.responseHeaders ?: emptyMap())
                // Mirrors src/electron.cjs's protocol.handle("app", …) header injection so the
                // SharedArrayBuffer-dependent wasm converters keep working here too.
                headers["Cross-Origin-Opener-Policy"] = "same-origin"
                headers["Cross-Origin-Embedder-Policy"] = "credentialless"
                headers["Cross-Origin-Resource-Policy"] = "same-origin"
                response.responseHeaders = headers
                return response
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                if (url.scheme == "http" || url.scheme == "https") {
                    openExternal(url)
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                view.evaluateJavascript(DOWNLOAD_INTERCEPT_SCRIPT, null)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: android.webkit.ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                pendingFileChooserCallback = filePathCallback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                return try {
                    fileChooserLauncher.launch(Intent.createChooser(intent, null))
                    true
                } catch (e: Exception) {
                    Log.e(TAG, "Could not launch file chooser", e)
                    pendingFileChooserCallback = null
                    filePathCallback.onReceiveValue(null)
                    false
                }
            }

            // target="_blank" / window.open(...) — route to the system browser, matching
            // src/electron.cjs's setWindowOpenHandler which denies in-app windows and opens
            // http(s) externally instead.
            //
            // Returning false denies the window outright. The usual trick — handing WebView a
            // transient WebView to read the URL out of — leaks that WebView on every popup,
            // and it is not needed here: the page always sets the anchor's href, so
            // getHitTestResult() carries the destination.
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean {
                val target = view.hitTestResult.extra
                if (target != null) {
                    val uri = Uri.parse(target)
                    if (uri.scheme == "http" || uri.scheme == "https") openExternal(uri)
                }
                return false
            }
        }

        webView.loadUrl("https://appassets.androidplatform.net/convert/index.html")

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        finish()
                    }
                }
            },
        )
    }

    private fun openExternal(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
        } catch (e: Exception) {
            Log.e(TAG, "Could not open external link: $url", e)
        }
    }

    /**
     * Serves the copied-in dist/ build from assets/convert/ (see the copyDistToAssets Gradle
     * task) for the "/convert/" prefix registered above — i.e. requests to
     * https://appassets.androidplatform.net/convert/<path> read assets/convert/<path>.
     *
     * Not androidx's built-in WebViewAssetLoader.AssetsPathHandler: that class serves
     * straight from the assets/ root (no subfolder), and its MIME sniffing falls back to
     * text/plain for extensions it doesn't recognise (notably .wasm and .mjs, both of
     * which this bundle relies on — WebAssembly.instantiateStreaming and <script
     * type="module"> both require the correct MIME type to work).
     */
    private inner class ConvertAssetsPathHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            // This handler is the only thing between a page-supplied path and the APK's
            // assets/, so refuse anything that could climb out of assets/convert/.
            if (path.startsWith("/") || path.contains("..") || path.contains('\\')) {
                Log.w(TAG, "Refusing suspicious asset path: $path")
                return null
            }
            val assetPath = "convert/$path"
            return try {
                val stream = assets.open(assetPath)
                WebResourceResponse(guessMimeType(assetPath), null, stream)
            } catch (e: IOException) {
                Log.w(TAG, "Asset not found: $assetPath")
                null
            }
        }
    }

    private fun guessMimeType(path: String): String {
        val extension = path.substringAfterLast('.', "").lowercase()
        EXTRA_MIME_TYPES[extension]?.let { return it }
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
    }

    /** One in-progress save: the MediaStore row plus the stream we are appending to. */
    private class SaveSession(val uri: Uri, val stream: OutputStream, val name: String)

    /**
     * The one JS bridge this wrapper adds. The upstream UI builds a conversion result as a
     * blob: URL and clicks a detached <a download> (see src/ui/pages/Conversion/index.tsx's
     * downloadFile()). A WebView cannot follow that download natively because the blob's
     * bytes live in the renderer, not at a fetchable network URL. The injected script below
     * intercepts it and streams the bytes here.
     *
     * The bytes arrive in chunks rather than as one base64 string: a whole-file string would
     * hold the result three times over (the data: URL in the renderer, the Java String, and
     * the decoded array), so a large video would exhaust the heap. Each chunk is decoded and
     * written straight into the MediaStore output stream, so peak memory is one chunk.
     */
    private inner class AndroidDownloader {
        private val sessions = java.util.concurrent.ConcurrentHashMap<String, SaveSession>()
        private val nextId = java.util.concurrent.atomic.AtomicLong(0)

        /** Opens the destination file. Returns a session id, or "" if it could not be created. */
        @JavascriptInterface
        fun saveBegin(filename: String, mime: String): String {
            val safeName = sanitiseFilename(filename)
            return try {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOCUMENTS + "/Convert")
                }
                val uri = contentResolver.insert(MediaStore.Files.getContentUri("external"), values)
                    ?: return ""
                val stream = contentResolver.openOutputStream(uri) ?: run {
                    contentResolver.delete(uri, null, null)
                    return ""
                }
                val id = nextId.incrementAndGet().toString()
                sessions[id] = SaveSession(uri, stream, safeName)
                id
            } catch (e: Throwable) {
                Log.e(TAG, "Could not start saving $safeName", e)
                ""
            }
        }

        /** Appends one base64 chunk. Returns false if the save has failed and should stop. */
        @JavascriptInterface
        fun saveChunk(id: String, base64Chunk: String): Boolean {
            val session = sessions[id] ?: return false
            return try {
                session.stream.write(Base64.decode(base64Chunk, Base64.DEFAULT))
                true
            } catch (e: Throwable) {
                Log.e(TAG, "Failed writing a chunk of ${session.name}", e)
                abort(id, session)
                false
            }
        }

        /** Closes the file and tells the user where it went. */
        @JavascriptInterface
        fun saveEnd(id: String): Boolean {
            val session = sessions.remove(id) ?: return false
            return try {
                session.stream.flush()
                session.stream.close()
                toast("Saved ${session.name} to Documents/Convert")
                true
            } catch (e: Throwable) {
                Log.e(TAG, "Failed finishing ${session.name}", e)
                runCatching { contentResolver.delete(session.uri, null, null) }
                toast("Could not save ${session.name}")
                false
            }
        }

        /** Drops a half-written file — nothing partial is left behind in Documents/Convert. */
        @JavascriptInterface
        fun saveAbort(id: String) {
            sessions.remove(id)?.let { abort(id, it) }
        }

        private fun abort(id: String, session: SaveSession) {
            sessions.remove(id)
            runCatching { session.stream.close() }
            runCatching { contentResolver.delete(session.uri, null, null) }
            toast("Could not save ${session.name}")
        }

        private fun toast(message: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show() }
        }
    }

    /**
     * Reduces a page-supplied download name to a bare filename: no directory separators, no
     * "..", no control or FAT-illegal characters, never empty. MediaStore scrubs DISPLAY_NAME
     * itself, but this wrapper should not depend on that to stay inside Documents/Convert.
     */
    private fun sanitiseFilename(raw: String): String {
        val base = raw.substringAfterLast('/').substringAfterLast('\\')
        val illegal = ":*?\"<>|/\\"
        val cleaned = base
            .map { if (it.code < 0x20 || it.code == 0x7F || illegal.indexOf(it) >= 0) '_' else it }
            .joinToString("")
            .trim()
            .trim('.')
        return if (cleaned.isEmpty()) "download" else cleaned.take(200)
    }

    companion object {
        private const val TAG = "Convert"

        // MimeTypeMap.getMimeTypeFromExtension() is unreliable across OEM/API-level tables
        // for these — wrong MIME here breaks module script execution or wasm streaming
        // compilation, so they're pinned explicitly rather than trusted to the platform.
        private val EXTRA_MIME_TYPES = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "wasm" to "application/wasm",
            "ico" to "image/x-icon",
            "svg" to "image/svg+xml",
            "sf2" to "application/octet-stream",
            "tar" to "application/x-tar",
            "elf" to "application/octet-stream",
            "bin" to "application/octet-stream",
        )

        // Streams a finished conversion to the bridge in 1 MiB slices. The upstream page
        // builds the result as a blob and clicks a detached <a download>; nothing else in the
        // page is touched.
        private const val SAVE_CHUNK_BYTES = 1 shl 20

        private val DOWNLOAD_INTERCEPT_SCRIPT = """
            (function() {
              if (window.__androidDownloadPatched) return;
              window.__androidDownloadPatched = true;
              var CHUNK = $SAVE_CHUNK_BYTES;

              function toBase64(buffer) {
                var bytes = new Uint8Array(buffer);
                var binary = '';
                var step = 0x8000;
                for (var i = 0; i < bytes.length; i += step) {
                  binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
                }
                return btoa(binary);
              }

              function saveBlob(blob, filename) {
                var bridge = window.AndroidDownloader;
                if (!bridge || !bridge.saveBegin) return Promise.resolve();
                var id = bridge.saveBegin(filename, blob.type || 'application/octet-stream');
                if (!id) {
                  console.error('Android save could not be started for ' + filename);
                  return Promise.resolve();
                }
                var offset = 0;
                function step() {
                  if (offset >= blob.size) { bridge.saveEnd(id); return; }
                  var end = Math.min(offset + CHUNK, blob.size);
                  var slice = blob.slice(offset, end);
                  offset = end;
                  return slice.arrayBuffer().then(function(buffer) {
                    if (!bridge.saveChunk(id, toBase64(buffer))) return;
                    return step();
                  });
                }
                return Promise.resolve().then(step).catch(function(e) {
                  bridge.saveAbort(id);
                  console.error('Android save failed', e);
                });
              }

              // Remember the Blob behind each blob: URL, so the download can be sliced
              // straight from it. fetch()ing the URL back would materialise the whole result
              // in memory first, which defeats the point of chunking (and fails outright on a
              // few hundred MB). Only the last few are kept, so this cannot grow.
              var recent = [];
              var origCreateObjectURL = URL.createObjectURL;
              URL.createObjectURL = function(object) {
                var url = origCreateObjectURL.call(URL, object);
                if (object instanceof Blob) {
                  recent.push({ url: url, blob: object });
                  if (recent.length > 8) recent.shift();
                }
                return url;
              };
              var origRevokeObjectURL = URL.revokeObjectURL;
              URL.revokeObjectURL = function(url) {
                forget(url);
                return origRevokeObjectURL.call(URL, url);
              };
              function known(url) {
                for (var i = recent.length - 1; i >= 0; i--) {
                  if (recent[i].url === url) return recent[i].blob;
                }
                return null;
              }
              function forget(url) {
                for (var i = recent.length - 1; i >= 0; i--) {
                  if (recent[i].url === url) recent.splice(i, 1);
                }
              }

              var origClick = HTMLAnchorElement.prototype.click;
              HTMLAnchorElement.prototype.click = function() {
                try {
                  var href = this.href || '';
                  if (this.hasAttribute('download') && href.indexOf('blob:') === 0) {
                    var filename = this.getAttribute('download') || 'download';
                    var blob = known(href);
                    var ready = blob
                      ? Promise.resolve(blob)
                      : fetch(href).then(function(r) { return r.blob(); });
                    ready.then(function(b) {
                      return saveBlob(b, filename);
                    }).catch(function(e) {
                      console.error('Android download intercept failed', e);
                    });
                    return;
                  }
                } catch (e) { console.error(e); }
                return origClick.call(this);
              };
            })();
        """.trimIndent()
    }
}
