// Generates icon_1024.png — the master art for the Convert repackage's LAUNCHER icon.
// This is PACKAGING CHROME ONLY (the .app/.exe + JBTheatreTools catalog tile). It does NOT
// touch the upstream app UI — the fork is p2r3/convert "unmodified except for packaging".
//
// EXACT ART = the design agent's signed-off spec (House Style v2, glyph-only, bus 2026-09-21):
// house dark squircle (#20242B, corner radius ~22.5%) and a convert-⇄ glyph in azure #2F86D6
// (Convert's formal owned accent — it also echoes Convert's own "big blue box"), centred and
// enlarged, NO wordmark. Glyph geometry transcribed 1:1 from the spec's 24-grid SVG (y flipped
// for AppKit). Matches SuiteDesignReview/kit/app-icons/convert/icon_1024.png pixel-for-pixel.
// Run:  swift make_icon.swift   (make_icon.sh packages it into .icns + .ico)
import AppKit

let size = 1024
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
let W = CGFloat(size)

// Convert's formal owned accent: azure #2F86D6 (dark-mode lift #5AA6EF).
let accent = NSColor(red: 0x2F/255.0, green: 0x86/255.0, blue: 0xD6/255.0, alpha: 1.0)   // #2F86D6

// --- Rounded-square background (macOS "squircle") — same family as the sibling apps ---
// Base fill #20242B, given a subtle top->bottom depth gradient centred on that tone so the tile
// reads coherently in the launcher grid.
let inset: CGFloat = 100
let bgRect = NSRect(x: inset, y: inset, width: W - inset * 2, height: W - inset * 2)
let radius = bgRect.width * 0.225                     // ~22.5% corner radius (spec)
let bgPath = NSBezierPath(roundedRect: bgRect, xRadius: radius, yRadius: radius)
let bgGradient = NSGradient(colors: [
    NSColor(red: 0.153, green: 0.169, blue: 0.196, alpha: 1.0),   // ~#272B32 (a touch lighter)
    NSColor(red: 0.098, green: 0.114, blue: 0.137, alpha: 1.0)    // ~#191D23 (a touch darker)
])!                                                                // midpoint ≈ #20242B
bgPath.addClip()
bgGradient.draw(in: bgRect, angle: -90)

// Inner top highlight for depth.
ctx.resetClip(); bgPath.addClip()
NSGradient(colors: [NSColor(white: 1.0, alpha: 0.08), NSColor(white: 1.0, alpha: 0.0)])!
    .draw(in: NSRect(x: bgRect.minX, y: bgRect.midY, width: bgRect.width, height: bgRect.height / 2), angle: -90)
ctx.resetClip()

// Thin border to crisp the edge.
NSColor(white: 1.0, alpha: 0.06).setStroke()
let border = NSBezierPath(roundedRect: bgRect.insetBy(dx: 2, dy: 2), xRadius: radius, yRadius: radius)
border.lineWidth = 3; border.stroke()

// --- convert-⇄ glyph (spec-exact, 24-grid) — glyph-only, centred (House Style v2) ------------
// House Style v2 icon grammar is glyph-led with NO wordmark (design 2026-09-21, rule 4/15). The
// glyph is drawn in its original 24-grid coordinates, then centred + enlarged on the tile by a
// single transform (design-provided: maps the glyph's measured bounds to centred on (512,512) at
// 60% of the 824px tile; CG y-up). Spec y is DOWN; flip for AppKit (y up).
let unit: CGFloat = 18.5        // px per grid unit
let gcx: CGFloat = bgRect.midX  // grid centre x (u = 12)
let gcy: CGFloat = 610          // grid centre y (v = 12), AppKit coords
func gx(_ u: CGFloat) -> CGFloat { gcx + (u - 12) * unit }
func gy(_ v: CGFloat) -> CGFloat { gcy + (12 - v) * unit }
let gsw = 1.7 * unit            // stroke-width 1.7 on the 24-grid

func stroked(_ pts: [(CGFloat, CGFloat)]) {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: gx(pts[0].0), y: gy(pts[0].1)))
    for q in pts.dropFirst() { p.line(to: NSPoint(x: gx(q.0), y: gy(q.1))) }
    p.lineWidth = gsw; p.lineCapStyle = .round; p.lineJoinStyle = .round; p.stroke()
}
ctx.saveGState()
ctx.translateBy(x: -259.75, y: -407.46)   // design-provided: centre the glyph on (512,512)…
ctx.scaleBy(x: 1.5073, y: 1.5073)         // …at 60% of the tile
accent.setStroke()
stroked([(4, 9), (17.5, 9)])                 // top shaft  (points right)
stroked([(14, 5.5), (18, 9), (14, 12.5)])    // top head
stroked([(20, 15), (6.5, 15)])               // bottom shaft (points left)
stroked([(10, 11.5), (6, 15), (10, 18.5)])   // bottom head
ctx.restoreGState()

NSGraphicsContext.restoreGraphicsState()
let outURL = URL(fileURLWithPath: "icon_1024.png")
try! rep.representation(using: .png, properties: [:])!.write(to: outURL)
print("Wrote \(outURL.path)  (glyph-only)")
