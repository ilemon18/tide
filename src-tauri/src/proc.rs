//! Single entry point for child processes.
//!
//! Tide is a GUI-subsystem program (`windows_subsystem = "windows"`), so on Windows every time it
//! launches a console program (git / formatter / taskkill) the OS opens a new console window for
//! it — visible as "a black box flashing on every git call". All child processes build their
//! Command here, which always adds `CREATE_NO_WINDOW`.

use std::process::Command;

/// CREATE_NO_WINDOW: do not create a console window
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a Command that never pops a console
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    hide_console(&mut cmd);
    cmd
}

/// Add "no console popup" to an already built Command (for cases that wire up their own pipes)
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
