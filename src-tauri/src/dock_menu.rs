//! macOS Dock context menu: "Opened" + "Recent" sections, one click to open / focus a window.
//!
//! AppKit only attaches a Dock menu when the NSApplication delegate implements
//! `applicationDockMenu:`, and tao owns that delegate. So instead of replacing the delegate we
//! add just this one method to its class via class_addMethod, leaving other behaviour
//! (reopen / quit / open urls) untouched.
//!
//! The menu is rebuilt on every popup: the recent list changing (open/close project) needs no sync.

use std::cell::RefCell;
use std::path::Path;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{define_class, ffi, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{NSObject, NSString};
use tauri::AppHandle;

use crate::commands::theme::read_session;

/// Max number of projects listed in the Dock menu
const MAX_RECENT: usize = 5;

/// Menu clicks need an AppHandle to open windows, so remember it at install time
static APP: OnceLock<AppHandle> = OnceLock::new();

thread_local! {
    /// Menu item tag → project path. The whole menu is replaced on each rebuild and clicks look
    /// the path up by tag, so no path string has to be parsed back out of an ObjC object.
    /// "Opened" and "Recent" share this one index table.
    static ITEM_PATHS: RefCell<Vec<String>> = RefCell::new(Vec::new());
    /// A menu item's target is a weak reference, so both the menu and the target are kept
    /// here until the next rebuild
    static MENU: RefCell<Option<Retained<NSMenu>>> = RefCell::new(None);
    static TARGET: RefCell<Option<Retained<DockTarget>>> = RefCell::new(None);
}

define_class!(
    /// Click target for menu items: AppKit uses target/action and the target must be an ObjC object
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TideDockMenuTarget"]
    #[ivars = ()]
    struct DockTarget;

    impl DockTarget {
        /// One entry of "Recent"
        #[unsafe(method(dockOpenRecent:))]
        fn open_recent(&self, sender: &NSMenuItem) {
            let index = sender.tag();
            if index < 0 {
                return;
            }
            let path = ITEM_PATHS.with(|list| list.borrow().get(index as usize).cloned());
            let Some(path) = path else { return };
            let Some(app) = APP.get().cloned() else { return };
            if let Err(e) = crate::open_project(&app, &path) {
                eprintln!("[Tide] dock menu: opening project failed: {e}");
            }
        }

        /// "New window" at the bottom of the menu
        #[unsafe(method(dockNewWindow:))]
        fn new_window(&self, _sender: &NSMenuItem) {
            let Some(app) = APP.get().cloned() else { return };
            if let Err(e) = crate::open_empty_window(&app, None) {
                eprintln!("[Tide] dock menu: opening a new window failed: {e}");
            }
        }
    }
);

impl DockTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = mtm.alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Install the Dock menu. Must be called on the main thread (from setup at startup).
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[Tide] dock menu must be installed on the main thread, skipped");
        return;
    };

    TARGET.with(|slot| *slot.borrow_mut() = Some(DockTarget::new(mtm)));

    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate: *mut AnyObject = unsafe { msg_send![&ns_app, delegate] };
    if delegate.is_null() {
        eprintln!("[Tide] NSApplication has no delegate, dock menu skipped");
        return;
    }

    let cls = unsafe { (*delegate).class() } as *const AnyClass as *mut AnyClass;
    let imp: Imp = unsafe {
        std::mem::transmute(
            application_dock_menu
                as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject,
        )
    };
    // Each of return NSMenu, self, _cmd, NSApplication takes one @
    let types = c"@@:@";
    let added = unsafe { ffi::class_addMethod(cls, sel!(applicationDockMenu:), imp, types.as_ptr()) };
    if !added.as_bool() {
        // The delegate already has this method (tao may implement it later): replace it with ours instead
        unsafe { ffi::class_replaceMethod(cls, sel!(applicationDockMenu:), imp, types.as_ptr()) };
    }
}

/// AppKit calls this when it asks the delegate for the Dock menu.
///
/// SAFETY: only called by AppKit on the main thread; the returned menu is strongly held by
/// `MENU` and stays valid until the next rebuild.
unsafe extern "C-unwind" fn application_dock_menu(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> *mut AnyObject {
    match build_menu() {
        Some(menu) => Retained::as_ptr(&menu) as *mut AnyObject,
        None => std::ptr::null_mut(),
    }
}

/// Build a fresh Dock menu: "Opened" + "Recent" sections + new window
fn build_menu() -> Option<Retained<NSMenu>> {
    let app = APP.get()?.clone();
    let mtm = MainThreadMarker::new()?;

    // Native menu labels follow the UI language from settings (after a language change the menu
    // pops up in the new language next time)
    let locale = crate::i18n::Locale::from_tag(&crate::commands::theme::read_settings(&app).locale);
    let tr = crate::i18n::strings(locale);

    let session = read_session(&app);
    // Already open projects: ordered by "Recent" first, those not in the recent list (opened long
    // ago) appended at the end
    let mut open_paths = crate::open_root_paths(&app);
    let mut open_items: Vec<(String, String)> = Vec::new();
    for item in &session.recent {
        if let Some(pos) = open_paths.iter().position(|path| *path == item.path) {
            open_items.push((display_name(&item.name, &item.path), item.path.clone()));
            open_paths.remove(pos);
        }
    }
    for path in open_paths {
        open_items.push((display_name("", &path), path));
    }

    // Open projects are already removed from "Recent", so no project shows up twice
    let open_set: Vec<&str> = open_items.iter().map(|(_, path)| path.as_str()).collect();
    let recent_items: Vec<(String, String)> = session
        .recent
        .iter()
        .filter(|item| !open_set.contains(&item.path.as_str()))
        .take(MAX_RECENT)
        .map(|item| (display_name(&item.name, &item.path), item.path.clone()))
        .collect();

    let target = TARGET.with(|slot| slot.borrow().clone())?;
    let target_ref: &AnyObject = unsafe { &*(Retained::as_ptr(&target) as *const AnyObject) };

    let menu = NSMenu::new(mtm);
    // Control clickability ourselves instead of letting AppKit auto-disable via the responder chain
    menu.setAutoenablesItems(false);

    // tag is an index into the table below; the opened / recent groups are appended in order
    let mut paths: Vec<String> = Vec::new();

    if open_items.is_empty() && recent_items.is_empty() {
        let item = plain_item(mtm, tr.empty);
        item.setEnabled(false);
        menu.addItem(&item);
    } else {
        if !open_items.is_empty() {
            add_header(&menu, mtm, tr.opened);
            for (name, path) in &open_items {
                let tag = paths.len() as isize;
                paths.push(path.clone());
                menu.addItem(&open_item(mtm, name, tag, target_ref));
            }
        }
        if !recent_items.is_empty() {
            add_header(&menu, mtm, tr.recent);
            for (name, path) in &recent_items {
                let tag = paths.len() as isize;
                paths.push(path.clone());
                menu.addItem(&open_item(mtm, name, tag, target_ref));
            }
        }
    }

    menu.addItem(&NSMenuItem::separatorItem(mtm));
    let new_window = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str(tr.new_window),
            Some(sel!(dockNewWindow:)),
            &NSString::from_str(""),
        )
    };
    unsafe { new_window.setTarget(Some(target_ref)) };
    menu.addItem(&new_window);

    ITEM_PATHS.with(|list| {
        let mut list = list.borrow_mut();
        list.clear();
        list.extend(paths);
    });

    // Keep our own strong reference: it must not be collected before AppKit is done, and gets replaced on the next rebuild
    MENU.with(|slot| *slot.borrow_mut() = Some(menu.clone()));
    Some(menu)
}

/// Non-clickable section header
fn add_header(menu: &NSMenu, mtm: MainThreadMarker, title: &str) {
    let item = plain_item(mtm, title);
    item.setEnabled(false);
    menu.addItem(&item);
}

/// Menu item without an action (section header / empty-state hint)
fn plain_item(mtm: MainThreadMarker, title: &str) -> Retained<NSMenuItem> {
    unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str(title),
            None,
            &NSString::from_str(""),
        )
    }
}

/// Clickable project item: click goes to `dockOpenRecent:`, tag points at the path table index
fn open_item(
    mtm: MainThreadMarker,
    title: &str,
    tag: isize,
    target: &AnyObject,
) -> Retained<NSMenuItem> {
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str(title),
            Some(sel!(dockOpenRecent:)),
            &NSString::from_str(""),
        )
    };
    item.setTag(tag);
    unsafe { item.setTarget(Some(target)) };
    item
}

/// Name shown in the menu: prefer the recorded project name, fall back to the directory name
fn display_name(name: &str, path: &str) -> String {
    if !name.trim().is_empty() {
        return name.to_string();
    }
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}
