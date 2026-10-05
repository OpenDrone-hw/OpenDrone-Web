// Detail tier (owner: shell). Pure logic: which layers of the scan a device loads first.
// The scan is split by opacity into two layers that together are the full scan, every Gaussian once:
//   scan/          base layer, the Gaussians with opacity >= 16/255: every surface, about 60 % of the Gaussians
//   scan-detail/   detail layer, opacity 2/255 to 15/255: faint Gaussians that add fine shading
// Gaussians with opacity <= 1/255 are left out; PlayCanvas never draws them (alphaClipForward 1/255).
// Tier 'full' loads the base layer, shows the lab, then adds the detail layer. Tier 'mobile' loads only the base
// layer, and adds the detail layer later only when the device shows headroom (js/quality.js easyAtMax). A full-tier
// device that stays late at its lowest render resolution drops the detail layer again (slowAtMin).
//
// The first choice uses capability signals, not the user agent: memory and cores where the browser reports them
// (Chromium), Save-Data, a coarse pointer on a phone-sized screen, and whether WebGPU exists.

// signals: { param, touch, screenMin (CSS px), deviceMemory (GB or undefined), cores, saveData, webgpu }
export function chooseTier(sig) {
  if (sig.param === 'full' || sig.param === 'mobile') return { tier: sig.param, reasons: ['param'] };
  const reasons = [];
  if (Number.isFinite(sig.deviceMemory) && sig.deviceMemory <= 4) reasons.push('memory ' + sig.deviceMemory + ' GB');
  if (Number.isFinite(sig.cores) && sig.cores <= 4) reasons.push('cores ' + sig.cores);
  if (sig.saveData) reasons.push('save-data');
  if (sig.touch && Number.isFinite(sig.screenMin) && sig.screenMin < 768) reasons.push('phone screen');
  if (sig.touch && !sig.webgpu) reasons.push('touch without WebGPU');
  return { tier: reasons.length ? 'mobile' : 'full', reasons };
}

// windows (half a second each) before the detail layer is added on a mobile-tier device or dropped on a slow one
export const TIER_WINDOWS = { add: 10, drop: 6 };

export function readSignals(param, touch) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const scr = typeof screen !== 'undefined' ? screen : {};
  return {
    param,
    touch,
    screenMin: Math.min(scr.width || Infinity, scr.height || Infinity),
    deviceMemory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    saveData: !!(nav.connection && nav.connection.saveData),
    webgpu: !!nav.gpu
  };
}
