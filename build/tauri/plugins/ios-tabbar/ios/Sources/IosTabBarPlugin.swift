import Foundation
import SwiftRs
import Tauri
import UIKit

// The system tab bar for the library destinations. It is a plain UITabBar with the default appearance, which
// the iOS 26 SDK draws as Liquid Glass and earlier systems draw as the standard bar; nothing here restyles it,
// and no private API is used. It overlays the web view, so the web layer reserves room for it using the height
// reported here. Only the system's own chrome is glass: the web content stays flat.

struct TabItem: Decodable {
    let key: String
    let title: String
    let symbol: String
}

struct ConfigureArgs: Decodable {
    let items: [TabItem]
    let selected: Int?
    let minMajor: Int? // the bar is added only from this iOS major version (26 draws it as Liquid Glass)
    let onEvent: Channel
}

struct SelectArgs: Decodable {
    let index: Int // -1 selects nothing (a page outside the four, such as Settings)
}

struct AppearanceArgs: Decodable {
    let dark: Bool
    let tint: String? // #RRGGBB for the selected item (the app's ink colour)
}

struct VisibilityArgs: Decodable {
    let hidden: Bool
}

// Reports its height whenever it is laid out (rotation, a hidden bar, a changed safe area)
final class ReportingTabBar: UITabBar {
    var onHeight: ((CGFloat) -> Void)?
    private var lastHeight: CGFloat = -1

    override func layoutSubviews() {
        super.layoutSubviews()
        let height = isHidden ? 0 : (superview.map { $0.bounds.height - frame.minY } ?? bounds.height)
        if abs(height - lastHeight) > 0.5 {
            lastHeight = height
            onHeight?(height)
        }
    }

    func reportAgain() {
        lastHeight = -1
        setNeedsLayout()
    }
}

class IosTabBarPlugin: Plugin, UITabBarDelegate {
    private var bar: ReportingTabBar?
    private var keys: [String] = []
    private var channel: Channel?

    @objc public func configure(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ConfigureArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
            if major < (args.minMajor ?? 0) {
                invoke.resolve(["supported": false, "major": major])
                return
            }
            guard let window = self.keyWindow() else {
                invoke.reject("No key window.")
                return
            }
            self.channel = args.onEvent
            let bar = self.bar ?? self.makeBar(in: window)
            self.keys = args.items.map { $0.key }
            bar.items = args.items.enumerated().map { index, item in
                let tabItem = UITabBarItem(title: item.title, image: UIImage(systemName: item.symbol), tag: index)
                tabItem.accessibilityLabel = item.title
                return tabItem
            }
            self.select(args.selected ?? 0, on: bar)
            bar.reportAgain()
            invoke.resolve(["supported": true, "major": major])
        }
    }

    @objc public func select(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SelectArgs.self)
        DispatchQueue.main.async { [weak self] in
            if let bar = self?.bar { self?.select(args.index, on: bar) }
            invoke.resolve()
        }
    }

    @objc public func visibility(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(VisibilityArgs.self)
        DispatchQueue.main.async { [weak self] in
            self?.bar?.isHidden = args.hidden
            self?.bar?.reportAgain()
            invoke.resolve()
        }
    }

    // The bar follows the app's theme, not the system's, so a dark theme on a light system still reads
    @objc public func appearance(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AppearanceArgs.self)
        DispatchQueue.main.async { [weak self] in
            self?.dark = args.dark
            self?.tintHex = args.tint
            if let bar = self?.bar { self?.applyAppearance(to: bar) }
            invoke.resolve()
        }
    }

    private var dark = true
    private var tintHex: String?

    private func applyAppearance(to bar: UITabBar) {
        bar.overrideUserInterfaceStyle = dark ? .dark : .light
        if let hex = tintHex, hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) {
            bar.tintColor = UIColor(
                red: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1)
        }
    }

    private func select(_ index: Int, on bar: UITabBar) {
        if let items = bar.items, index >= 0, index < items.count {
            bar.selectedItem = items[index]
        } else {
            bar.selectedItem = nil
        }
    }

    private func makeBar(in window: UIWindow) -> ReportingTabBar {
        let bar = ReportingTabBar()
        bar.delegate = self
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.onHeight = { [weak self] height in
            self?.channel?.send(["type": "height", "value": Double(height)])
        }
        applyAppearance(to: bar)
        window.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: window.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: window.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: window.bottomAnchor),
        ])
        self.bar = bar
        return bar
    }

    private func keyWindow() -> UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            if let key = windowScene.windows.first(where: { $0.isKeyWindow }) { return key }
            if let first = windowScene.windows.first { return first }
        }
        return nil
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard item.tag >= 0, item.tag < keys.count else { return }
        channel?.send(["type": "selected", "key": keys[item.tag], "index": item.tag])
    }
}

@_cdecl("init_plugin_ios_tabbar")
public func initPlugin() -> Plugin {
    return IosTabBarPlugin()
}
