//! Android-native half of the app: the `blobbies-android` Tauri mobile plugin
//! (Kotlin class `com.blobbies.app.BlobbiesPlugin`).
//!
//! Provides Keystore-backed secret storage for `secrets.rs` and the share
//! sheet inbox (`take_pending_share`, plus the `share` plugin event). The
//! allowlist is enforced in `secrets.rs` before anything reaches here.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::Wry;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};

use crate::error::{Error, Result};

static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

#[derive(Serialize)]
struct NameArgs<'a> {
    name: &'a str,
}

#[derive(Serialize)]
struct SetArgs<'a> {
    name: &'a str,
    value: &'a str,
}

#[derive(Deserialize)]
struct ValueResponse {
    value: Option<String>,
}

fn handle() -> Result<&'static PluginHandle<Wry>> {
    HANDLE
        .get()
        .ok_or_else(|| Error::Io("android plugin not initialised".to_owned()))
}

/// Map plugin errors without echoing anything that might contain a value.
fn plugin_error(error: &tauri::plugin::mobile::PluginInvokeError) -> Error {
    Error::Io(format!("secure storage failed: {error}"))
}

pub(crate) fn secret_get(name: &str) -> Result<Option<String>> {
    let response: ValueResponse = handle()?
        .run_mobile_plugin("secretGet", NameArgs { name })
        .map_err(|e| plugin_error(&e))?;
    Ok(response.value)
}

pub(crate) fn secret_set(name: &str, value: &str) -> Result<()> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("secretSet", SetArgs { name, value })
        .map_err(|e| plugin_error(&e))?;
    Ok(())
}

pub(crate) fn secret_delete(name: &str) -> Result<()> {
    handle()?
        .run_mobile_plugin::<serde_json::Value>("secretDelete", NameArgs { name })
        .map_err(|e| plugin_error(&e))?;
    Ok(())
}

/// The Android plugin. JS calls `plugin:blobbies-android|take_pending_share`
/// (routed straight to Kotlin's `takePendingShare`) and listens for `share`.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::<Wry>::new("blobbies-android")
        .setup(|_app, api| {
            let handle = api.register_android_plugin("com.blobbies.app", "BlobbiesPlugin")?;
            // Set once per process; a second setup would be a bug, and the
            // first handle stays valid, so ignoring the error is safe.
            let _ = HANDLE.set(handle);
            Ok(())
        })
        .build()
}
