//! Production-parity checks for the HTTP capability scope.
//!
//! The scope is data, so TypeScript cannot type-check it. These tests use the
//! same `urlpattern` crate and parsing adjustments as `tauri-plugin-http` 2.5.9;
//! browser `URLPattern` is both absent on supported Node 22 and rejects valid
//! Tauri wildcards such as `https://**`.

use std::error::Error as StdError;

use serde_json::Value;
use url::Url;
use urlpattern::{UrlPattern, UrlPatternInit, UrlPatternMatchInput, UrlPatternOptions};

type TestResult<T = ()> = Result<T, Box<dyn StdError>>;

fn parse_pattern(value: &str) -> TestResult<UrlPattern> {
    let mut init = UrlPatternInit::parse_constructor_string::<regex::Regex>(value, None)?;
    if init.search.as_ref().is_none_or(String::is_empty) {
        init.search.replace("*".to_owned());
    }
    if init.hash.as_ref().is_none_or(String::is_empty) {
        init.hash.replace("*".to_owned());
    }
    if init
        .pathname
        .as_ref()
        .is_none_or(|path| path.is_empty() || path == "/")
    {
        init.pathname.replace("*".to_owned());
    }
    Ok(UrlPattern::parse(init, UrlPatternOptions::default())?)
}

fn http_scope() -> TestResult<(Vec<String>, Vec<String>)> {
    let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json"))?;
    let permissions = capability
        .get("permissions")
        .and_then(Value::as_array)
        .ok_or_else(|| std::io::Error::other("capability permissions must be an array"))?;
    let scope = permissions
        .iter()
        .find(|entry| entry.get("identifier").and_then(Value::as_str) == Some("http:default"))
        .ok_or_else(|| std::io::Error::other("http:default capability is missing"))?;

    let entries = |key: &str| -> TestResult<Vec<String>> {
        scope
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| std::io::Error::other(format!("http:default {key} must be an array")))?
            .iter()
            .map(|entry| {
                entry
                    .get("url")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        std::io::Error::other(format!("http:default {key} entry needs a URL"))
                            .into()
                    })
            })
            .collect()
    };

    Ok((entries("allow")?, entries("deny")?))
}

fn reachable(value: &str, allow: &[UrlPattern], deny: &[UrlPattern]) -> TestResult<bool> {
    let url = Url::parse(value)?;
    let matches = |pattern: &UrlPattern| {
        pattern
            .test(UrlPatternMatchInput::Url(url.clone()))
            .unwrap_or_default()
    };
    Ok(allow.iter().any(matches) && !deny.iter().any(matches))
}

fn parsed_scope() -> TestResult<(Vec<UrlPattern>, Vec<UrlPattern>)> {
    let (allow, deny) = http_scope()?;
    Ok((
        allow
            .iter()
            .map(String::as_str)
            .map(parse_pattern)
            .collect::<TestResult<_>>()?,
        deny.iter()
            .map(String::as_str)
            .map(parse_pattern)
            .collect::<TestResult<_>>()?,
    ))
}

#[test]
fn every_http_pattern_parses_with_tauris_matcher() -> TestResult {
    let (allow, deny) = http_scope()?;
    for pattern in allow.iter().chain(&deny) {
        parse_pattern(pattern)?;
    }
    Ok(())
}

#[test]
fn web_tool_hosts_are_allowed() -> TestResult {
    let (allow, deny) = parsed_scope()?;
    for url in [
        "https://www.bing.com/search?q=ollama&setlang=en-US",
        "https://lite.duckduckgo.com/lite/",
        "https://example.com/page",
    ] {
        assert!(reachable(url, &allow, &deny)?, "{url} must be reachable");
    }
    Ok(())
}

#[test]
fn local_and_private_networks_are_denied() -> TestResult {
    let (allow, deny) = parsed_scope()?;
    for url in [
        "https://127.0.0.1:11434/api/tags",
        "https://localhost:3000/admin",
        "https://[::1]/x",
        "https://192.168.1.1/",
        "https://10.0.0.5/",
        "https://172.20.0.1/",
        "https://169.254.169.254/latest/meta-data",
        "https://100.64.0.1/",
        "https://printer.local/",
    ] {
        assert!(!reachable(url, &allow, &deny)?, "{url} must be denied");
    }
    Ok(())
}

#[test]
fn default_and_non_default_ports_need_separate_patterns() -> TestResult {
    let default_port = parse_pattern(r"https://:private(192\.168\.[0-9]+\.[0-9]+)/**")?;
    assert!(reachable(
        "https://192.168.1.1/",
        std::slice::from_ref(&default_port),
        &[],
    )?);

    let any_non_default_port = parse_pattern(r"https://:private(192\.168\.[0-9]+\.[0-9]+):*/**")?;
    assert!(reachable(
        "https://192.168.1.1:8443/",
        std::slice::from_ref(&any_non_default_port),
        &[],
    )?);
    Ok(())
}
