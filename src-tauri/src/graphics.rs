use serde::Serialize;

const RENDERERS: [&str; 3] = ["auto", "gpu", "cpu"];
const QUALITIES: [&str; 4] = ["auto", "high", "medium", "low"];
const GB: u64 = 1024 * 1024 * 1024;

pub fn normalize_renderer(value: &str) -> String {
    let v = value.trim().to_lowercase();
    if RENDERERS.contains(&v.as_str()) { v } else { "auto".into() }
}

pub fn normalize_quality(value: &str) -> String {
    let v = value.trim().to_lowercase();
    if QUALITIES.contains(&v.as_str()) { v } else { "auto".into() }
}

pub fn machine_tier(cpus: usize, totalmem: u64) -> &'static str {
    if cpus <= 2 || totalmem < 4 * GB {
        "low"
    } else if cpus <= 4 || totalmem < 8 * GB {
        "medium"
    } else {
        "high"
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Detected {
    pub gpu: bool,
    pub tier: String,
    pub reason: String,
}

pub fn detect() -> Detected {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let tier = machine_tier(cpus, system.total_memory()).to_string();
    match software_gpu() {
        Some(true) => Detected { gpu: false, tier, reason: "software GPU driver".into() },
        Some(false) => Detected { gpu: true, tier, reason: "GPU available".into() },
        None => Detected { gpu: true, tier, reason: "GPU status unknown".into() },
    }
}

#[cfg(target_os = "linux")]
fn software_gpu() -> Option<bool> {
    let output = std::process::Command::new("glxinfo").arg("-B").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let renderer = text.lines().find(|l| l.contains("opengl renderer string"))?;
    Some(["llvmpipe", "softpipe", "swiftshader", "software rasterizer"].iter().any(|n| renderer.contains(n)))
}

#[cfg(not(target_os = "linux"))]
fn software_gpu() -> Option<bool> {
    None
}

#[derive(Clone, Debug)]
pub struct Resolved {
    pub renderer: String,
    pub quality: String,
    pub auto_renderer: bool,
}

pub fn resolve(renderer: &str, quality: &str, detected: Option<&Detected>) -> Resolved {
    let renderer = normalize_renderer(renderer);
    let quality = normalize_quality(quality);
    let (gpu, tier) = detected.map(|d| (d.gpu, d.tier.as_str())).unwrap_or((true, "high"));
    let resolved_renderer = if renderer == "auto" { if gpu { "gpu" } else { "cpu" }.to_string() } else { renderer.clone() };
    let resolved_quality = if quality == "auto" {
        let tier = if ["low", "medium", "high"].contains(&tier) { tier } else { "high" };
        if !gpu && tier == "high" { "medium".to_string() } else { tier.to_string() }
    } else {
        quality
    };
    Resolved { renderer: resolved_renderer, quality: resolved_quality, auto_renderer: renderer == "auto" }
}

pub fn projector_render_mode(resolved: &Resolved, fallback: &str) -> String {
    if !std::env::var("DB_FLASH_RENDER").unwrap_or_default().trim().is_empty() {
        return fallback.to_string();
    }
    if resolved.renderer == "cpu" {
        return String::new();
    }
    if resolved.auto_renderer && crate::config::PLATFORM != "win32" {
        return String::new();
    }
    "direct".into()
}

pub fn flash_quality(quality: &str) -> &'static str {
    match quality {
        "low" => "LOW",
        "medium" => "MEDIUM",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers() {
        assert_eq!(machine_tier(2, 16 * GB), "low");
        assert_eq!(machine_tier(8, 3 * GB), "low");
        assert_eq!(machine_tier(4, 16 * GB), "medium");
        assert_eq!(machine_tier(8, 16 * GB), "high");
    }

    #[test]
    fn auto_caps_quality_without_gpu() {
        let d = Detected { gpu: false, tier: "high".into(), reason: String::new() };
        let r = resolve("auto", "auto", Some(&d));
        assert_eq!(r.renderer, "cpu");
        assert_eq!(r.quality, "medium");
        assert_eq!(flash_quality(&r.quality), "MEDIUM");
    }
}
