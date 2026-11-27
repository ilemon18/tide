//! Native caption cursor rectangles; AppKit still owns button layout, drawing and actions.

#[cfg(target_os = "macos")]
mod mac {
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use objc2_app_kit::{NSButton, NSCursor, NSWindow, NSWindowButton};
    use std::ffi::CString;
    use tauri::Manager;

    const CLASS_PREFIX: &[u8] = b"TideCaptionPointer_";

    /// A shared, ivar-free subclass per native button class; never modify AppKit classes globally.
    fn cursor_class(base: &AnyClass) -> Option<&'static AnyClass> {
        let name = CString::new(format!(
            "TideCaptionPointer_{}",
            base.name().to_string_lossy()
        ))
        .ok()?;
        if let Some(class) = AnyClass::get(&name) {
            return Some(class);
        }
        let mut builder = ClassBuilder::new(&name, base)?;
        // The original object's allocation must remain valid after switching to this subclass.
        unsafe {
            builder.add_method(
                sel!(resetCursorRects),
                reset_cursor_rects as unsafe extern "C-unwind" fn(*mut AnyObject, Sel),
            );
        }
        Some(builder.register())
    }

    fn native_parent(mut class: &AnyClass) -> Option<&AnyClass> {
        loop {
            if class.name().to_bytes().starts_with(CLASS_PREFIX) {
                return class.superclass();
            }
            class = class.superclass()?;
        }
    }

    /// AppKit calls this again after redraw/resize/focus; a transient mouse-enter cursor would be reset.
    unsafe extern "C-unwind" fn reset_cursor_rects(this: *mut AnyObject, _cmd: Sel) {
        let this = unsafe { &*this };
        let Some(parent) = native_parent(this.class()) else {
            return;
        };
        let _: () = unsafe { msg_send![super(this, parent), resetCursorRects] };
        // This method is installed only on native NSButton subclasses, on AppKit's main thread.
        let button = unsafe { &*(this as *const AnyObject as *const NSButton) };
        let cursor = if button.isEnabled() {
            NSCursor::pointingHandCursor()
        } else {
            NSCursor::operationNotAllowedCursor()
        };
        button.addCursorRect_cursor(button.bounds(), &cursor);
    }

    pub fn install(app: &tauri::AppHandle, label: &str) {
        let handle = app.clone();
        let label = label.to_string();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window(&label) else {
                return;
            };
            let Ok(pointer) = window.ns_window() else {
                return;
            };
            // Look up live objects only on the main thread. No retained windows/buttons or tracking timers.
            unsafe {
                let native = &*(pointer as *const NSWindow);
                for kind in [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ] {
                    let Some(button) = native.standardWindowButton(kind) else {
                        continue;
                    };
                    let object = &*(std::ptr::from_ref(&*button) as *const AnyObject);
                    if native_parent(object.class()).is_none() {
                        let Some(class) = cursor_class(object.class()) else {
                            continue;
                        };
                        // No ivars added, and only resetCursorRects changes; preserve all native actions.
                        AnyObject::set_class(object, class);
                    }
                    native.invalidateCursorRectsForView(&button);
                }
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2::ClassType;
        use objc2_foundation::NSObject;

        #[test]
        fn cursor_subclass_reuses_registration_and_preserves_native_instance_layout() {
            // Objective-C runtime only: no NSApplication, windows or GUI automation.
            let base = NSObject::class();
            let class = cursor_class(base).expect("register cursor subclass");
            assert_eq!(class.instance_size(), base.instance_size());
            assert!(std::ptr::eq(
                class.superclass().expect("native parent"),
                base
            ));
            assert!(std::ptr::eq(
                cursor_class(base).expect("reuse registration"),
                class
            ));
            assert!(std::ptr::eq(
                native_parent(class).expect("find native parent"),
                base
            ));
            assert!(native_parent(base).is_none());
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::install;

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle, _label: &str) {}
