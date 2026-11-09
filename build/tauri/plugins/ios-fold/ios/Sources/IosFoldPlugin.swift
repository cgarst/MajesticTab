import Foundation
import SwiftRs
import Tauri
import UIKit
import ObjectiveC

// Fold and hinge state for the iPhone Duo (iOS 27.1 and later), handed to the web layer because WKWebView does not
// expose Device Posture or Viewport Segments. Public UIKit only: the division region (`reservedRegions`) says where the
// fold is and which way it runs, and `UIHingeInteraction` says when the hinge moves. The pose is derived from the
// region, never from a device name, and a hinge status is never re-derived from the angle (the system decides it).
//
// Poses sent to the page:
//  - "none"     the device has no fold (or the OS is older than 27.1)
//  - "flat"     a fold exists but is inactive (open flat, or closed on the outer display)
//  - "tabletop" the division region is active and wider than tall: the crease runs across, content up, controls down
//  - "book"     the division region is active and taller than wide: the crease runs up and down
// Frames are in window points, which are CSS pixels in the web view.

struct StartArgs: Decodable {
    let onEvent: Channel
}

// Full-window, invisible, and never hit: it exists to hold the hinge interaction and to hear every size change
final class FoldProbe: UIView {
    var onLayout: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onLayout?()
    }
}

public class IosFoldPlugin: Plugin {
    private var channel: Channel?
    private var probe: FoldProbe?
    private var interaction: AnyObject? // UIHingeInteraction, kept untyped so the file loads on older systems
    private var hingeStatus = "unknown"
    private var hingeAngle: Double = -1
    private var last = ""

    @objc public func start(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(StartArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.channel = args.onEvent
            self.last = "" // a page that (re)connects hears the current state again
            guard #available(iOS 27.1, *) else {
                invoke.resolve(["supported": false])
                return
            }
            guard let window = self.keyWindow() else {
                invoke.reject("No key window.")
                return
            }
            if self.probe == nil {
                let probe = FoldProbe(frame: window.bounds)
                probe.onLayout = { [weak self] in self?.report() }
                window.addSubview(probe)
                window.sendSubviewToBack(probe)
                guard let interaction = self.makeHingeInteraction() else {
                    probe.removeFromSuperview()
                    invoke.resolve(["supported": false])
                    return
                }
                probe.addInteraction(interaction)
                self.interaction = interaction as AnyObject
                self.probe = probe
            }
            self.report()
            invoke.resolve(["supported": true])
        }
    }

    @objc public func stop(_ invoke: Invoke) throws {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.probe?.onLayout = nil
            self.probe?.removeFromSuperview()
            self.probe = nil
            self.interaction = nil
            self.channel = nil
            invoke.resolve()
        }
    }

    // Reads the current pose and tells the page when something it can use changed. Cheap to call often: it sends
    // nothing for a repeat, and a hinge angle change alone (no new frame, same status) is not worth a message.
    private func report() {
        guard #available(iOS 27.1, *), let probe = probe, probe.window != nil else { return }
        var pose = "none"
        var frame = CGRect.zero
        if let region = divisionRegion(of: probe) {
            frame = region.frame
            if !region.active {
                pose = "flat"
            } else {
                pose = frame.width > frame.height ? "tabletop" : "book"
            }
        }
        let bounds = probe.bounds
        func n(_ v: CGFloat) -> String { String(Int(v.rounded())) }
        let key = [pose, hingeStatus, n(frame.minX), n(frame.minY), n(frame.width), n(frame.height), n(bounds.width), n(bounds.height)].joined(separator: ",")
        if key == last { return }
        last = key
        try? channel?.send([
            "type": "fold",
            "pose": pose,
            "hinge": hingeStatus,
            "angle": String(Int(hingeAngle.rounded())),
            "x": n(frame.minX), "y": n(frame.minY), "w": n(frame.width), "h": n(frame.height),
            "winW": n(bounds.width), "winH": n(bounds.height)
        ])
    }

    // The 27.1 APIs are reached through the Objective-C runtime so this compiles on SDKs older than 27.1 (direct use
    // fails to build there, and #available only guards at run time). Selectors and keys are the public header names.
    private func makeHingeInteraction() -> UIInteraction? {
        guard let cls = NSClassFromString("UIHingeInteraction") as? NSObject.Type else { return nil }
        let sel = NSSelectorFromString("initWithUpdateHandler:")
        guard let method = class_getInstanceMethod(cls, sel) else { return nil }
        typealias Handler = @convention(block) (AnyObject, AnyObject) -> Void
        typealias Init = @convention(c) (AnyObject, Selector, Handler) -> AnyObject
        let initialize = unsafeBitCast(method_getImplementation(method), to: Init.self)
        let handler: Handler = { [weak self] _, update in
            guard let self = self else { return }
            if let hinge = (update as? NSObject)?.value(forKey: "hinge") as? NSObject {
                // UIHingeStatus: 0 unknown, 1 closed, 2 partially open, 3 fully open
                switch (hinge.value(forKey: "status") as? Int) ?? 0 {
                case 1: self.hingeStatus = "closed"
                case 2: self.hingeStatus = "partial"
                case 3: self.hingeStatus = "open"
                default: self.hingeStatus = "unknown"
                }
                self.hingeAngle = ((hinge.value(forKey: "angle") as? Double) ?? 0) * 180 / .pi
            } else {
                self.hingeStatus = "unknown"
                self.hingeAngle = -1
            }
            self.report()
        }
        guard let allocated = (cls as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() else { return nil }
        return initialize(allocated, sel, handler) as? UIInteraction
    }

    // First division region of the view, active or not (UIViewReservedRegionQueryOptionsIncludeInactive is 1)
    private func divisionRegion(of view: UIView) -> (frame: CGRect, active: Bool)? {
        let sel = NSSelectorFromString("reservedRegionsOfKind:options:")
        guard view.responds(to: sel),
              let kindCls = NSClassFromString("UIViewReservedRegionKind") as? NSObject.Type,
              let kind = kindCls.perform(NSSelectorFromString("divisionRegionKind"))?.takeUnretainedValue(),
              let method = class_getInstanceMethod(UIView.self, sel) else { return nil }
        typealias Query = @convention(c) (AnyObject, Selector, AnyObject, UInt) -> NSArray
        let query = unsafeBitCast(method_getImplementation(method), to: Query.self)
        guard let region = query(view, sel, kind, 1).firstObject as? NSObject,
              let frame = region.value(forKey: "frame") as? CGRect else { return nil }
        return (frame, (region.value(forKey: "active") as? Bool) ?? false)
    }

    private func keyWindow() -> UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            if let key = windowScene.windows.first(where: { $0.isKeyWindow }) { return key }
            if let first = windowScene.windows.first { return first }
        }
        return nil
    }
}

@_cdecl("init_plugin_ios_fold")
public func initPlugin() -> Plugin {
    return IosFoldPlugin()
}
