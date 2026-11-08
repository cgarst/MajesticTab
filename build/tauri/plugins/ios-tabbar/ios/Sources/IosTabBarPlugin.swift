import Foundation
import SwiftRs
import Tauri
import UIKit

// The system chrome for the library destinations, drawn natively so iOS 26 draws it as Liquid Glass. Public UIKit
// only (UITabBar, UISearchBar, UIGlassEffect); nothing is restyled with private API. It overlays the web view, so the
// web layer reserves room for it using the inset reported here. Only this system chrome is glass: web content stays
// flat.
//
// Two shapes:
//  - a horizontal UITabBar along the bottom (phones, iPads, and the iPhone Duo in portrait);
//  - a vertical glass rail in the strip the system reserves for a vertical bar (iPhone Duo in landscape). iOS only adapts bars it builds itself (UITabBarController and friends), and a
//    UITabBar added by hand stays horizontal, so the rail is our own stack of buttons on a UIGlassEffect. Which one
//    applies is read from `traitCollection.verticalBarEdge` (iOS 27.1), never from a device name.
//
// The library search field sits at the top of the window and mirrors the web field.

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

struct SearchArgs: Decodable {
    let visible: Bool
    let placeholder: String?
    let text: String?
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

final class ReportingSearchBar: UISearchBar {
    var onLayout: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

// Spans the window, draws nothing and takes no touches; it only hears about size, safe-area and trait changes
// (rotation, folding the device, Split View) so the layout can follow the system's choice of bar.
final class LayoutProbe: UIView {
    var onChange: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isHidden = false
        backgroundColor = .clear
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        onChange?()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        onChange?()
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        onChange?()
    }
}

class IosTabBarPlugin: Plugin, UITabBarDelegate, UISearchBarDelegate {
    private var items: [TabItem] = []
    private var keys: [String] = []
    private var channel: Channel?
    private var selectedIndex = -1
    private var webHidden = true // the web layer's wish: hidden outside the library and on wide layouts
    private var dark = true
    private var tintHex: String?

    private var bar: ReportingTabBar?
    private var rail: UIVisualEffectView?
    private var railButtons: [UIButton] = []
    private var railWidth: NSLayoutConstraint?
    private var railRight: NSLayoutConstraint?
    private var railLeft: NSLayoutConstraint?
    private var probe: LayoutProbe?

    private var search: ReportingSearchBar?
    private var searchWanted = false
    private var searchTop: NSLayoutConstraint?
    private var searchLeading: NSLayoutConstraint?
    private var searchTrailing: NSLayoutConstraint?

    private var verticalEdge = 0 // 0 none, 1 leading, 2 trailing (UIVerticalBarEdge)
    private var lastInset: CGFloat = -1
    private var lastTop: CGFloat = -1
    private var lastCorner: CGFloat = -1
    private var sideReserved: (left: CGFloat, right: CGFloat) = (0, 0)
    private var lastSide: (left: CGFloat, right: CGFloat) = (-1, -1)

    // MARK: - Commands

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
            self.items = args.items
            self.keys = args.items.map { $0.key }
            // A page that (re)connects starts with no chrome; it says what it wants next (a reload while a score is open must not keep the library's bar)
            self.webHidden = true
            self.searchWanted = false
            // ...and hears every value again (its CSS variables start empty), so nothing is skipped as unchanged
            self.lastInset = -1
            self.lastTop = -1
            self.lastCorner = -1
            self.lastSide = (-1, -1)
            self.verticalEdge = -1
            if self.bar == nil { self.makeChrome(in: window) }
            self.fillItems()
            self.selectItem(args.selected ?? 0)
            self.relayout()
            invoke.resolve(["supported": true, "major": major, "vertical": self.verticalEdge != 0])
        }
    }

    @objc public func select(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SelectArgs.self)
        DispatchQueue.main.async { [weak self] in
            self?.selectItem(args.index)
            invoke.resolve()
        }
    }

    @objc public func visibility(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(VisibilityArgs.self)
        DispatchQueue.main.async { [weak self] in
            self?.webHidden = args.hidden
            self?.relayout()
            invoke.resolve()
        }
    }

    // The bar follows the app's theme, not the system's, so a dark theme on a light system still reads
    @objc public func appearance(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AppearanceArgs.self)
        DispatchQueue.main.async { [weak self] in
            self?.dark = args.dark
            self?.tintHex = args.tint
            self?.applyAppearance()
            invoke.resolve()
        }
    }

    // The library's search field. The web keeps the real field and its logic; this one mirrors its text in both
    // directions (the `search` event) and is hidden when the page has no search.
    @objc public func search(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SearchArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.searchWanted = args.visible
            if args.visible, self.search == nil, let window = self.bar?.superview as? UIWindow { self.makeSearch(in: window) }
            if let search = self.search {
                if let placeholder = args.placeholder, search.placeholder != placeholder { search.placeholder = placeholder }
                if let text = args.text, search.text != text, !search.searchTextField.isFirstResponder { search.text = text }
            }
            self.relayout()
            invoke.resolve()
        }
    }

    // MARK: - Building

    private func makeChrome(in window: UIWindow) {
        let probe = LayoutProbe()
        probe.translatesAutoresizingMaskIntoConstraints = false
        probe.onChange = { [weak self] in self?.relayout() }
        window.addSubview(probe)
        NSLayoutConstraint.activate([
            probe.leadingAnchor.constraint(equalTo: window.leadingAnchor),
            probe.trailingAnchor.constraint(equalTo: window.trailingAnchor),
            probe.topAnchor.constraint(equalTo: window.topAnchor),
            probe.bottomAnchor.constraint(equalTo: window.bottomAnchor),
        ])
        self.probe = probe

        let bar = ReportingTabBar()
        bar.delegate = self
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.isHidden = true
        bar.onHeight = { [weak self] _ in self?.reportInset() }
        window.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: window.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: window.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: window.bottomAnchor),
        ])
        self.bar = bar

        makeRail(in: window)
        applyAppearance()
    }

    private func makeRail(in window: UIWindow) {
        let effect: UIVisualEffect
        if #available(iOS 26.0, *) {
            effect = UIGlassEffect()
        } else {
            effect = UIBlurEffect(style: .systemThinMaterial)
        }
        let rail = UIVisualEffectView(effect: effect)
        rail.translatesAutoresizingMaskIntoConstraints = false
        rail.isHidden = true
        rail.layer.cornerRadius = 32
        rail.layer.cornerCurve = .continuous
        rail.clipsToBounds = true
        window.addSubview(rail)

        let width = rail.widthAnchor.constraint(equalToConstant: 72)
        let right = rail.trailingAnchor.constraint(equalTo: window.trailingAnchor, constant: -6)
        let left = rail.leadingAnchor.constraint(equalTo: window.leadingAnchor, constant: 6)
        NSLayoutConstraint.activate([
            width,
            right,
            rail.bottomAnchor.constraint(equalTo: window.safeAreaLayoutGuide.bottomAnchor, constant: -6),
        ])
        left.isActive = false
        self.rail = rail
        self.railWidth = width
        self.railRight = right
        self.railLeft = left
    }

    private func makeSearch(in window: UIWindow) {
        let field = ReportingSearchBar()
        field.delegate = self
        field.searchBarStyle = .minimal
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .search
        field.translatesAutoresizingMaskIntoConstraints = false
        field.isHidden = true
        field.overrideUserInterfaceStyle = dark ? .dark : .light
        // On a wide screen (a foldable, an iPad) UIKit would cap the field at a readable width; it should span like the tab bar
        if #available(iOS 17.0, *) { field.traitOverrides.horizontalSizeClass = .compact }
        field.onLayout = { [weak self] in self?.reportInset() }
        window.addSubview(field)

        let leading = field.leadingAnchor.constraint(equalTo: window.leadingAnchor, constant: 16)
        let trailing = field.trailingAnchor.constraint(equalTo: window.trailingAnchor, constant: -16)
        // At the top of the window, below the status area (relayout sets the constant)
        let top = field.topAnchor.constraint(equalTo: window.topAnchor, constant: 8)
        NSLayoutConstraint.activate([leading, trailing, top])
        self.search = field
        self.searchLeading = leading
        self.searchTrailing = trailing
        self.searchTop = top
    }

    private func fillItems() {
        bar?.items = items.enumerated().map { index, item in
            let tabItem = UITabBarItem(title: item.title, image: UIImage(systemName: item.symbol), tag: index)
            tabItem.accessibilityLabel = item.title
            return tabItem
        }
        guard let rail = rail else { return }
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 4
        stack.alignment = .fill
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        railButtons = items.enumerated().map { index, item in
            var config = UIButton.Configuration.plain()
            config.image = UIImage(systemName: item.symbol)
            config.title = item.title
            config.imagePlacement = .top
            config.imagePadding = 3
            config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 2, bottom: 8, trailing: 2)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attrs in
                var next = attrs
                next.font = UIFont.systemFont(ofSize: 10, weight: .semibold)
                return next
            }
            config.background.cornerRadius = 22
            let button = UIButton(configuration: config)
            button.tag = index
            button.accessibilityLabel = item.title
            button.addAction(UIAction { [weak self] _ in self?.userSelected(index) }, for: .touchUpInside)
            button.configurationUpdateHandler = { [weak self] b in
                var c = b.configuration
                let tint = self?.tintColor() ?? .label
                c?.baseForegroundColor = b.isSelected ? tint : UIColor.secondaryLabel
                c?.background.backgroundColor = b.isSelected ? tint.withAlphaComponent(0.16) : .clear
                b.configuration = c
            }
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
            stack.addArrangedSubview(button)
            return button
        }
        rail.contentView.subviews.forEach { $0.removeFromSuperview() }
        rail.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: rail.contentView.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: rail.contentView.bottomAnchor, constant: -8),
            stack.leadingAnchor.constraint(equalTo: rail.contentView.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: rail.contentView.trailingAnchor, constant: -6),
        ])
    }

    // MARK: - Layout

    // The system's choice of bar edge: 0 none (horizontal bar), 1 leading, 2 trailing. iOS 27.1 and later.
    private func systemVerticalEdge(_ window: UIWindow) -> Int {
        // Read through the Objective-C runtime so this compiles on SDKs older than 27.1 (a direct property access
        // fails to build there, and #available only guards at run time). Raw values: 0 none, 1 leading, 2 trailing.
        let traits = window.traitCollection
        guard traits.responds(to: NSSelectorFromString("verticalBarEdge")),
              let raw = traits.value(forKey: "verticalBarEdge") as? Int else { return 0 }
        return (raw == 1 || raw == 2) ? raw : 0
    }

    // Picks the bar for the current pose and places everything; cheap to call often
    func relayout() {
        guard let bar = bar, let window = bar.superview as? UIWindow else { return }
        // The side rail only where the system wants one AND the window is landscape; in portrait (the Duo's inner or outer
        // display held upright) the horizontal bar is used, as on any iPhone
        let landscape = window.bounds.width > window.bounds.height
        let edge = landscape ? systemVerticalEdge(window) : 0
        let vertical = edge != 0
        if edge != verticalEdge {
            verticalEdge = edge
            try? channel?.send(["type": "mode", "vertical": vertical ? "1" : "0"])
        }
        let barHidden = webHidden || vertical
        if bar.isHidden != barHidden { bar.isHidden = barHidden; bar.reportAgain() }
        let railHidden = webHidden || !vertical
        if rail?.isHidden != railHidden { rail?.isHidden = railHidden }

        if vertical {
            // The strip is the safe-area inset on the bar's physical side (the bar keeps its side in right-to-left)
            let ltr = window.effectiveUserInterfaceLayoutDirection == .leftToRight
            let onRight = (edge == 2) == ltr
            let strip = max(onRight ? window.safeAreaInsets.right : window.safeAreaInsets.left, 0)
            // A fixed width: the system does not always reserve its strip for our window (the inner display in landscape
            // reports none), so the rail and everything beside it are sized from the rail itself
            let width = max(72, strip - 12)
            let reserved = max(strip, width + 6)
            if railWidth?.constant != width { railWidth?.constant = width }
            if railRight?.isActive != onRight { railRight?.isActive = onRight }
            if railLeft?.isActive != !onRight { railLeft?.isActive = !onRight }
            // Search stays clear of the strip
            let margin: CGFloat = 16
            let trailing = onRight ? -(reserved + margin) : -margin
            let leading = onRight ? margin : reserved + margin
            sideReserved = (onRight ? 0 : reserved, onRight ? reserved : 0)
            if searchTrailing?.constant != trailing { searchTrailing?.constant = trailing }
            if searchLeading?.constant != leading { searchLeading?.constant = leading }
        } else {
            sideReserved = (0, 0)
            if searchTrailing?.constant != -16 { searchTrailing?.constant = -16 }
            if searchLeading?.constant != 16 { searchLeading?.constant = 16 }
        }
        let statusBottom = window.windowScene?.statusBarManager?.statusBarFrame.maxY ?? 0
        // A wide window with a tall top inset (the iPhone Duo held upright) keeps its status as a cluster in the top-right
        // corner of that band and reports no inset for it: the field sits in the band, left of the cluster. Elsewhere
        // (phones, iPads) the status spans the band, so the field goes below it.
        let statusCorner = !vertical && window.bounds.width >= 600 && window.safeAreaInsets.top >= 70
        let statusClear: CGFloat = 130
        // The page keeps its own top row clear of the cluster too (the reader's top bar)
        let corner: CGFloat = statusCorner ? statusClear : 0
        if corner != lastCorner {
            lastCorner = corner
            try? channel?.send(["type": "corner", "value": Double(corner)])
        }
        // (the rail's strip carries the status in landscape, so the band above the content is free there too)
        let topConstant: CGFloat = (statusCorner || vertical) ? 28 : max(window.safeAreaInsets.top, statusBottom) + 8
        if !vertical {
            let trailing: CGFloat = statusCorner ? -statusClear : -16
            if searchTrailing?.constant != trailing { searchTrailing?.constant = trailing }
        }
        if searchTop?.constant != topConstant { searchTop?.constant = topConstant }

        let showSearch = searchWanted && !webHidden
        if search?.isHidden != !showSearch {
            search?.isHidden = !showSearch
            if !showSearch { search?.searchTextField.resignFirstResponder() }
        }
        applyAppearance()
        reportInset()
    }

    // Space the page reserves at the bottom: the horizontal bar and the search field above it, or just the search
    // field when the rail is at the side (the side strip is already a safe-area inset the page honours)
    func reportInset() {
        guard let bar = bar, let window = bar.superview else { return }
        var top = window.bounds.height
        if !bar.isHidden { top = min(top, bar.frame.minY) }
        if sideReserved != lastSide {
            lastSide = sideReserved
            try? channel?.send(["type": "side", "left": String(Double(sideReserved.left)), "right": String(Double(sideReserved.right))])
        }
        let searchBottom: CGFloat = (search != nil && !search!.isHidden) ? search!.frame.maxY + 8 : 0
        if abs(searchBottom - lastTop) > 0.5 {
            lastTop = searchBottom
            try? channel?.send(["type": "top", "value": Double(searchBottom)])
        }
        let inset = window.bounds.height - top
        if abs(inset - lastInset) > 0.5 {
            lastInset = inset
            try? channel?.send(["type": "height", "value": Double(inset)])
        }
    }

    // MARK: - Selection and appearance

    private func selectItem(_ index: Int) {
        selectedIndex = index
        if let tabItems = bar?.items, index >= 0, index < tabItems.count {
            bar?.selectedItem = tabItems[index]
        } else {
            bar?.selectedItem = nil
        }
        for (i, button) in railButtons.enumerated() {
            button.isSelected = i == index
            button.accessibilityTraits = i == index ? [.button, .selected] : [.button]
        }
    }

    private func userSelected(_ index: Int) {
        guard index >= 0, index < keys.count else { return }
        selectItem(index)
        try? channel?.send(["type": "selected", "key": keys[index], "index": String(index)])
    }

    private func tintColor() -> UIColor? {
        guard let hex = tintHex, hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1)
    }

    private func applyAppearance() {
        let style: UIUserInterfaceStyle = dark ? .dark : .light
        bar?.overrideUserInterfaceStyle = style
        rail?.overrideUserInterfaceStyle = style
        search?.overrideUserInterfaceStyle = style
        if let tint = tintColor() { bar?.tintColor = tint }
        railButtons.forEach { $0.setNeedsUpdateConfiguration() }
    }

    // MARK: - Delegates

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        userSelected(item.tag)
    }

    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        try? channel?.send(["type": "search", "text": searchText])
    }

    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
        searchBar.resignFirstResponder()
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

@_cdecl("init_plugin_ios_tabbar")
public func initPlugin() -> Plugin {
    return IosTabBarPlugin()
}
