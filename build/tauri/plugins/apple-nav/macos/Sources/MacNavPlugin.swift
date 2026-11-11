import AppKit
import Foundation
import SwiftUI
import WebKit

// MARK: - Main Thread Helper

private func runOnMain<T>(_ block: () -> T) -> T {
    if Thread.isMainThread { return block() }
    return DispatchQueue.main.sync(execute: block)
}

private func runOnMainAsync(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() }
    else { DispatchQueue.main.async(execute: block) }
}

// MARK: - MacRailButton

final class MacRailButton: NSControl {
    override var mouseDownCanMoveWindow: Bool { return false }

    let index: Int
    let key: String
    private let titleText: String
    private let symbolName: String

    var isSelected: Bool = false {
        didSet {
            updateAppearance()
            needsDisplay = true
        }
    }

    var isHovered: Bool = false {
        didSet {
            updateAppearance()
            needsDisplay = true
        }
    }

    var isExpanded: Bool = false {
        didSet {
            needsLayout = true
            needsDisplay = true
        }
    }

    var tintColor: NSColor = .controlAccentColor {
        didSet { updateAppearance() }
    }

    var onAction: ((Int, String) -> Void)?

    private var trackingArea: NSTrackingArea?
    private let iconView = NSImageView()
    private let labelField = NSTextField(labelWithString: "")
    private let dotLayer = CALayer()

    init(index: Int, key: String, title: String, symbol: String) {
        self.index = index
        self.key = key
        self.titleText = title
        self.symbolName = symbol
        super.init(frame: .zero)
        setupViews()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func setupViews() {
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = false

        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: titleText) {
            img.isTemplate = true
            iconView.image = img
        }
        addSubview(iconView)

        labelField.stringValue = titleText
        labelField.alignment = .center
        labelField.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        labelField.textColor = .secondaryLabelColor
        labelField.translatesAutoresizingMaskIntoConstraints = false
        labelField.isSelectable = false
        labelField.isEditable = false
        addSubview(labelField)

        dotLayer.bounds = CGRect(x: 0, y: 0, width: 5, height: 5)
        dotLayer.cornerRadius = 2.5
        dotLayer.isHidden = true
        layer?.addSublayer(dotLayer)

        updateAppearance()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea { removeTrackingArea(existing) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
    }

    override func mouseDown(with event: NSEvent) {
        onAction?(index, key)
    }

    func updateAppearance() {
        let fg: NSColor
        if isSelected {
            fg = tintColor
            layer?.backgroundColor = tintColor.withAlphaComponent(0.14).cgColor
            dotLayer.backgroundColor = tintColor.cgColor
            dotLayer.isHidden = false
        } else if isHovered {
            fg = .labelColor
            layer?.backgroundColor = NSColor.quaternaryLabelColor.cgColor
            dotLayer.isHidden = true
        } else {
            fg = .secondaryLabelColor
            layer?.backgroundColor = NSColor.clear.cgColor
            dotLayer.isHidden = true
        }

        iconView.contentTintColor = fg
        labelField.textColor = fg
    }

    override func layout() {
        super.layout()
        let w = bounds.width
        let h = bounds.height

        if isExpanded {
            // Expanded row (212pt rail)
            let iconSize: CGFloat = 20
            iconView.frame = CGRect(x: 16, y: (h - iconSize) / 2, width: iconSize, height: iconSize)
            labelField.font = NSFont.systemFont(ofSize: 13, weight: isSelected ? .semibold : .medium)
            labelField.alignment = .left
            labelField.frame = CGRect(x: 48, y: (h - 18) / 2, width: max(0, w - 60), height: 18)
            dotLayer.position = CGPoint(x: 8, y: h / 2)
        } else {
            // Compact pill (76pt rail)
            let iconSize: CGFloat = 22
            iconView.frame = CGRect(x: (w - iconSize) / 2, y: h - iconSize - 8, width: iconSize, height: iconSize)
            labelField.font = NSFont.systemFont(ofSize: 10, weight: isSelected ? .semibold : .medium)
            labelField.alignment = .center
            labelField.frame = CGRect(x: 2, y: 5, width: w - 4, height: 14)
            dotLayer.position = CGPoint(x: 6, y: h / 2)
        }
    }
}

// MARK: - MacRailView

final class MacRailView: NSVisualEffectView {
    override var isFlipped: Bool { return true }
    override var mouseDownCanMoveWindow: Bool { return true }

    private let topStack = NSStackView()
    private var topConstraint: NSLayoutConstraint?
    private var widthConstraint: NSLayoutConstraint?

    private(set) var buttons: [MacRailButton] = []
    private(set) var settingsButton: MacRailButton?

    var currentWidth: CGFloat = 88 {
        didSet {
            widthConstraint?.constant = currentWidth
            let expanded = currentWidth >= 160
            buttons.forEach { $0.isExpanded = expanded }
            settingsButton?.isExpanded = expanded
            needsLayout = true
        }
    }

    override func mouseDown(with event: NSEvent) {
        let loc = convert(event.locationInWindow, from: nil)
        // Top 52pt header area (where traffic lights sit) drags the window
        if loc.y < 52 {
            window?.performDrag(with: event)
        } else {
            super.mouseDown(with: event)
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func setup() {
        wantsLayer = true
        material = .sidebar
        blendingMode = .behindWindow
        state = .active
        translatesAutoresizingMaskIntoConstraints = false

        topStack.orientation = .vertical
        topStack.spacing = 6
        topStack.alignment = .centerX
        topStack.distribution = .fillEqually
        topStack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(topStack)

        let top = topStack.topAnchor.constraint(equalTo: topAnchor, constant: 52)
        let leading = topStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6)
        let trailing = topStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6)
        NSLayoutConstraint.activate([top, leading, trailing])
        topConstraint = top
    }

    func setFullscreen(_ fullscreen: Bool) {
        topConstraint?.constant = fullscreen ? 16 : 52
        needsLayout = true
    }

    func attach(to container: NSView, width: CGFloat) {
        container.addSubview(self, positioned: .above, relativeTo: nil)
        let w = widthAnchor.constraint(equalToConstant: width)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: container.leadingAnchor),
            topAnchor.constraint(equalTo: container.topAnchor),
            bottomAnchor.constraint(equalTo: container.bottomAnchor),
            w
        ])
        widthConstraint = w
        currentWidth = width
    }

    func setButtons(top: [MacRailButton], settings: MacRailButton?) {
        buttons = top
        settingsButton?.removeFromSuperview()
        settingsButton = settings
        topStack.subviews.forEach { $0.removeFromSuperview() }

        for btn in top {
            btn.translatesAutoresizingMaskIntoConstraints = false
            topStack.addArrangedSubview(btn)
            NSLayoutConstraint.activate([
                btn.heightAnchor.constraint(equalToConstant: 48),
                btn.leadingAnchor.constraint(equalTo: topStack.leadingAnchor),
                btn.trailingAnchor.constraint(equalTo: topStack.trailingAnchor)
            ])
        }

        if let setBtn = settings {
            setBtn.translatesAutoresizingMaskIntoConstraints = false
            addSubview(setBtn)
            NSLayoutConstraint.activate([
                setBtn.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
                setBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
                setBtn.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
                setBtn.heightAnchor.constraint(equalToConstant: 48)
            ])
        }
    }
}

// MARK: - SwiftUI Liquid Glass Search Bar

final class SearchState: ObservableObject {
    @Published var query: String = ""
    @Published var placeholder: String = "Search your library or find any artist, song, or album…"
    var onSearchChange: ((String) -> Void)?
    var onSubmit: (() -> Void)?
}

struct MacLiquidGlassSearchBar: View {
    @ObservedObject var state: SearchState
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
                .font(.system(size: 15, weight: .medium))
            TextField(state.placeholder, text: $state.query)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .focused($isFocused)
                .onChange(of: state.query) { _, newValue in
                    state.onSearchChange?(newValue)
                }
                .onSubmit {
                    state.onSubmit?()
                }
            if !state.query.isEmpty {
                Button(action: {
                    state.query = ""
                    state.onSearchChange?("")
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                        .font(.system(size: 15))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(height: 40)
        .background(.ultraThinMaterial, in: Capsule())
    }
}

// MARK: - MacNavPlugin

final class MacNavPlugin: NSObject, WKUIDelegate {
    private weak var window: NSWindow?
    private var callback: (@convention(c) (UnsafePointer<CChar>?) -> Void)?

    private var railView: MacRailView?
    private let searchState = SearchState()
    private var searchHostingView: NSHostingView<MacLiquidGlassSearchBar>?
    private var searchLeadingConstraint: NSLayoutConstraint?
    private var searchTopConstraint: NSLayoutConstraint?
    private var searchWidthConstraint: NSLayoutConstraint?
    private var searchCustomBounds: Bool = false
    private var searchCustomX: CGFloat = 0
    private var searchCustomWidth: CGFloat = 0

    private var items: [(key: String, title: String, symbol: String)] = []
    private var selectedIndex: Int = -1
    private var isDark: Bool = true
    private var tintHex: String = "#808080"
    private var searchWanted: Bool = false
    private var webHidden: Bool = false

    init(window: NSWindow, callback: @escaping @convention(c) (UnsafePointer<CChar>?) -> Void) {
        self.window = window
        self.callback = callback
        super.init()

        // Instruct WebKit to open Developer Tools / Web Inspector in its own separate detached window
        UserDefaults.standard.set(false, forKey: "WebKit2InspectorStartsAttached")
        UserDefaults.standard.set(false, forKey: "WebKit2InspectorStartsAttachedAtBottom")
        UserDefaults.standard.set(false, forKey: "WebKit Web Inspector Setting - inspectorStartsAttached")
        UserDefaults.standard.set(false, forKey: "__WebInspectorPageGroupLevel1__.WebKit2InspectorStartsAttached")

        setupNotifications()

        // Automatically detach inspector into its own window once it initializes
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.detachInspector() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.detachInspector() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.detachInspector() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.detachInspector() }
    }

    func detachInspector() {
        guard let win = window, let cv = win.contentView else { return }
        func findWebView(_ view: NSView) -> WKWebView? {
            if let wv = view as? WKWebView { return wv }
            for sub in view.subviews {
                if let found = findWebView(sub) { return found }
            }
            return nil
        }
        guard let wv = findWebView(cv) else { return }
        configureWebView(wv)
        let inspSel = Selector(("_inspector"))
        let detachSel = Selector(("detach"))
        if wv.responds(to: inspSel),
           let tool = wv.perform(inspSel)?.takeUnretainedValue() as? NSObject,
           tool.responds(to: detachSel) {
            tool.perform(detachSel)
        }
    }

    private func configureWebView(_ wv: WKWebView) {
        if wv.uiDelegate == nil || !(wv.uiDelegate is MacNavPlugin) {
            wv.uiDelegate = self
        }
    }

    // MARK: - WKUIDelegate (Popups & Google Sign-In)

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let popupRect = NSRect(x: 0, y: 0, width: 520, height: 640)
        let popupWin = NSWindow(contentRect: popupRect, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        popupWin.title = "Google Sign-In"
        popupWin.center()
        let popupWV = WKWebView(frame: popupWin.contentView!.bounds, configuration: configuration)
        popupWV.autoresizingMask = [.width, .height]
        popupWV.uiDelegate = self
        popupWin.contentView?.addSubview(popupWV)
        popupWin.makeKeyAndOrderFront(nil)
        return popupWV
    }

    func webViewDidClose(_ webView: WKWebView) {
        if let win = webView.window, win != self.window {
            win.close()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func setupNotifications() {
        NotificationCenter.default.addObserver(self, selector: #selector(onWindowResize), name: NSWindow.didResizeNotification, object: window)
        NotificationCenter.default.addObserver(self, selector: #selector(onWindowWillEnterFullScreen), name: NSWindow.willEnterFullScreenNotification, object: window)
        NotificationCenter.default.addObserver(self, selector: #selector(onWindowDidEnterFullScreen), name: NSWindow.didEnterFullScreenNotification, object: window)
        NotificationCenter.default.addObserver(self, selector: #selector(onWindowDidExitFullScreen), name: NSWindow.didExitFullScreenNotification, object: window)
    }

    private func sendEvent(_ json: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: []),
              let str = String(data: data, encoding: .utf8) else { return }
        str.withCString { callback?($0) }
    }

    private func calculateSearchWidth(for windowWidth: CGFloat) -> CGFloat {
        let railW = railView?.currentWidth ?? 88
        let available = windowWidth - railW - 40
        return max(available, 280)
    }

    @objc private func onWindowResize() {
        guard let win = window else { return }
        let width: CGFloat = win.frame.width >= 1000 ? 212 : 88
        if railView?.currentWidth != width {
            railView?.currentWidth = width
            sendEvent(["type": "width", "value": Double(width)])
        }
        if let w = searchWidthConstraint, let cv = win.contentView {
            if searchCustomBounds {
                searchLeadingConstraint?.constant = searchCustomX
                w.constant = searchCustomWidth
            } else {
                searchLeadingConstraint?.constant = (railView?.currentWidth ?? 88) + 20
                w.constant = calculateSearchWidth(for: cv.bounds.width)
            }
        }
    }

    @objc private func onWindowWillEnterFullScreen() {
        railView?.setFullscreen(true)
        if searchWanted && !searchCustomBounds {
            searchTopConstraint?.constant = 10
        }
    }

    @objc private func onWindowDidEnterFullScreen() {
        onWindowResize()
    }

    @objc private func onWindowDidExitFullScreen() {
        railView?.setFullscreen(false)
        if searchWanted && !searchCustomBounds {
            searchTopConstraint?.constant = 16
        }
        onWindowResize()
    }

    func configure(items: [(key: String, title: String, symbol: String)], selected: Int?, minMajor: Int) -> Bool {
        let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        if major < minMajor { return false }
        guard let win = window, let contentView = win.contentView else { return false }

        self.items = items
        if railView == nil {
            let rail = MacRailView(frame: .zero)
            let initialWidth: CGFloat = win.frame.width >= 1000 ? 212 : 88
            rail.attach(to: contentView, width: initialWidth)
            rail.setFullscreen(win.styleMask.contains(.fullScreen))
            railView = rail
        }

        buildButtons()
        selectItem(selected ?? 0)
        applyAppearance()

        detachInspector()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.detachInspector() }

        sendEvent(["type": "width", "value": Double(railView?.currentWidth ?? 88)])
        return true
    }

    private func buildButtons() {
        guard let rail = railView else { return }
        var topBtns: [MacRailButton] = []
        var settingsBtn: MacRailButton?

        for (idx, item) in items.enumerated() {
            let btn = MacRailButton(index: idx, key: item.key, title: item.title, symbol: item.symbol)
            btn.isExpanded = rail.currentWidth >= 160
            btn.onAction = { [weak self] (clickedIdx, clickedKey) in
                self?.userSelected(clickedIdx, key: clickedKey)
            }
            if item.key == "settings" {
                settingsBtn = btn
            } else {
                topBtns.append(btn)
            }
        }
        rail.setButtons(top: topBtns, settings: settingsBtn)
    }

    private func userSelected(_ index: Int, key: String) {
        selectItem(index)
        sendEvent(["type": "selected", "key": key, "index": String(index)])
    }

    func selectItem(_ index: Int) {
        selectedIndex = index
        guard let rail = railView else { return }
        for btn in rail.buttons {
            btn.isSelected = (btn.index == index)
        }
        rail.settingsButton?.isSelected = (rail.settingsButton?.index == index)
    }

    func setVisibility(hidden: Bool) {
        webHidden = hidden
        railView?.isHidden = hidden
        searchHostingView?.isHidden = hidden || !searchWanted
    }

    func setAppearance(dark: Bool, tint: String) {
        isDark = dark
        tintHex = tint
        applyAppearance()
    }

    private func parseColor(_ hex: String) -> NSColor {
        var str = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if str.hasPrefix("#") { str.removeFirst() }
        guard str.count == 6, let val = UInt32(str, radix: 16) else { return .controlAccentColor }
        return NSColor(
            calibratedRed: CGFloat((val >> 16) & 0xFF) / 255.0,
            green: CGFloat((val >> 8) & 0xFF) / 255.0,
            blue: CGFloat(val & 0xFF) / 255.0,
            alpha: 1.0
        )
    }

    private func applyAppearance() {
        let app = NSAppearance(named: isDark ? .darkAqua : .aqua)
        railView?.appearance = app
        searchHostingView?.appearance = app

        let color = parseColor(tintHex)
        railView?.buttons.forEach { $0.tintColor = color }
        railView?.settingsButton?.tintColor = color
    }

    func setSearch(visible: Bool, placeholder: String?, text: String?, y: Double?, x: Double?, width: Double?) {
        searchWanted = visible
        guard let win = window, let contentView = win.contentView else { return }

        let isCustom = (x != nil && width != nil)
        searchCustomBounds = isCustom
        if let cx = x { searchCustomX = CGFloat(cx) }
        if let cw = width { searchCustomWidth = CGFloat(cw) }

        if visible && searchHostingView == nil {
            searchState.onSearchChange = { [weak self] query in
                self?.sendEvent(["type": "search", "text": query])
            }
            searchState.onSubmit = { [weak self] in
                self?.sendEvent(["type": "submit"])
            }
            let hosting = NSHostingView(rootView: MacLiquidGlassSearchBar(state: searchState))
            hosting.translatesAutoresizingMaskIntoConstraints = false
            contentView.addSubview(hosting, positioned: .above, relativeTo: nil)

            let defaultLeading = (railView?.currentWidth ?? 88) + 20
            let leading = hosting.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: isCustom ? searchCustomX : defaultLeading)
            let initialTop = CGFloat(y ?? (win.styleMask.contains(.fullScreen) ? 10 : 16))
            let top = hosting.topAnchor.constraint(equalTo: contentView.topAnchor, constant: initialTop)
            let height = hosting.heightAnchor.constraint(equalToConstant: 40)
            let initialWidth = isCustom ? searchCustomWidth : calculateSearchWidth(for: contentView.bounds.width)
            let widthConstraint = hosting.widthAnchor.constraint(equalToConstant: initialWidth)

            NSLayoutConstraint.activate([leading, top, height, widthConstraint])
            searchLeadingConstraint = leading
            searchTopConstraint = top
            searchWidthConstraint = widthConstraint
            searchHostingView = hosting
            applyAppearance()
        }

        if let hosting = searchHostingView {
            let shouldShow = visible && !webHidden
            hosting.isHidden = !shouldShow
            if shouldShow {
                contentView.addSubview(hosting, positioned: .above, relativeTo: nil)
            }
            if let ph = placeholder, searchState.placeholder != ph { searchState.placeholder = ph }
            if let txt = text, searchState.query != txt { searchState.query = txt }
            if isCustom {
                searchLeadingConstraint?.constant = searchCustomX
                searchWidthConstraint?.constant = searchCustomWidth
                if let customY = y {
                    searchTopConstraint?.constant = CGFloat(customY)
                }
            } else {
                let defaultLeading = (railView?.currentWidth ?? 88) + 20
                searchLeadingConstraint?.constant = defaultLeading
                searchWidthConstraint?.constant = calculateSearchWidth(for: contentView.bounds.width)
                if let customY = y {
                    searchTopConstraint?.constant = CGFloat(customY)
                } else {
                    let isFullscreen = win.styleMask.contains(.fullScreen)
                    searchTopConstraint?.constant = isFullscreen ? 10 : 16
                }
            }
        }

        let reportTop: Double = (visible && !webHidden && !isCustom) ? 68.0 : 0.0
        sendEvent(["type": "top", "value": reportTop])
    }
}

// MARK: - C ABI Exports

@_cdecl("apple_nav_mac_create")
public func appleNavMacCreate(
    windowPtr: UnsafeMutableRawPointer,
    callback: @escaping @convention(c) (UnsafePointer<CChar>?) -> Void
) -> UnsafeMutableRawPointer {
    runOnMain {
        let window = Unmanaged<NSWindow>.fromOpaque(windowPtr).takeUnretainedValue()
        let plugin = MacNavPlugin(window: window, callback: callback)
        return Unmanaged.passRetained(plugin).toOpaque()
    }
}

@_cdecl("apple_nav_mac_destroy")
public func appleNavMacDestroy(pluginPtr: UnsafeMutableRawPointer) {
    runOnMainAsync {
        Unmanaged<MacNavPlugin>.fromOpaque(pluginPtr).release()
    }
}

@_cdecl("apple_nav_mac_configure")
public func appleNavMacConfigure(
    pluginPtr: UnsafeMutableRawPointer,
    itemsJson: UnsafePointer<CChar>,
    selectedIndex: Int32,
    minMajor: Int32
) -> Bool {
    let jsonString = String(cString: itemsJson)
    guard let data = jsonString.data(using: .utf8),
          let array = try? JSONSerialization.jsonObject(with: data, options: []) as? [[String: Any]] else {
        return false
    }

    var items: [(key: String, title: String, symbol: String)] = []
    for dict in array {
        if let key = dict["key"] as? String,
           let title = dict["title"] as? String,
           let symbol = dict["symbol"] as? String {
            items.append((key: key, title: title, symbol: symbol))
        }
    }

    return runOnMain {
        let plugin = Unmanaged<MacNavPlugin>.fromOpaque(pluginPtr).takeUnretainedValue()
        return plugin.configure(items: items, selected: selectedIndex >= 0 ? Int(selectedIndex) : nil, minMajor: Int(minMajor))
    }
}

@_cdecl("apple_nav_mac_select")
public func appleNavMacSelect(pluginPtr: UnsafeMutableRawPointer, index: Int32) {
    runOnMainAsync {
        let plugin = Unmanaged<MacNavPlugin>.fromOpaque(pluginPtr).takeUnretainedValue()
        plugin.selectItem(Int(index))
    }
}

@_cdecl("apple_nav_mac_visibility")
public func appleNavMacVisibility(pluginPtr: UnsafeMutableRawPointer, hidden: Bool) {
    runOnMainAsync {
        let plugin = Unmanaged<MacNavPlugin>.fromOpaque(pluginPtr).takeUnretainedValue()
        plugin.setVisibility(hidden: hidden)
    }
}

@_cdecl("apple_nav_mac_appearance")
public func appleNavMacAppearance(
    pluginPtr: UnsafeMutableRawPointer,
    dark: Bool,
    tintHex: UnsafePointer<CChar>?
) {
    let tint = tintHex.map { String(cString: $0) } ?? "#808080"
    runOnMainAsync {
        let plugin = Unmanaged<MacNavPlugin>.fromOpaque(pluginPtr).takeUnretainedValue()
        plugin.setAppearance(dark: dark, tint: tint)
    }
}

@_cdecl("apple_nav_mac_search")
public func appleNavMacSearch(
    pluginPtr: UnsafeMutableRawPointer,
    visible: Bool,
    placeholder: UnsafePointer<CChar>?,
    text: UnsafePointer<CChar>?,
    hasY: Bool,
    y: Double,
    hasX: Bool,
    x: Double,
    hasWidth: Bool,
    width: Double
) {
    let ph = placeholder.map { String(cString: $0) }
    let txt = text.map { String(cString: $0) }
    runOnMainAsync {
        let plugin = Unmanaged<MacNavPlugin>.fromOpaque(pluginPtr).takeUnretainedValue()
        plugin.setSearch(
            visible: visible,
            placeholder: ph,
            text: txt,
            y: hasY ? y : nil,
            x: hasX ? x : nil,
            width: hasWidth ? width : nil
        )
    }
}
