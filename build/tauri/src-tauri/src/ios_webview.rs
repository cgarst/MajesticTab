// iOS: the colours and scroll behaviour of the app's web view, so it matches the app before the page has painted.

pub fn configure_ios_webview(window: &tauri::WebviewWindow, r: f64, g: f64, b: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_ui_kit::UIColor;

    let _ = window.with_webview(move |platform| unsafe {
        let webview_ptr = platform.inner().cast::<AnyObject>();
        let bg_color = UIColor::colorWithRed_green_blue_alpha(r / 255.0, g / 255.0, b / 255.0, 1.0);

        let _: () = msg_send![webview_ptr, setBackgroundColor: &*bg_color];
        let scroll_view: *mut AnyObject = msg_send![webview_ptr, scrollView];
        if !scroll_view.is_null() {
            let _: () = msg_send![scroll_view, setBackgroundColor: &*bg_color];
            // UIScrollViewContentInsetAdjustmentNever = 2
            let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2isize];
        }

        // UIUserInterfaceStyleDark = 2
        let _: () = msg_send![webview_ptr, setOverrideUserInterfaceStyle: 2isize];
        let _: () = msg_send![webview_ptr, setInspectable: true];
        let superview: *mut AnyObject = msg_send![webview_ptr, superview];
        if !superview.is_null() {
            let _: () = msg_send![superview, setBackgroundColor: &*bg_color];
            let _: () = msg_send![superview, setOverrideUserInterfaceStyle: 2isize];
        }
    });
}
