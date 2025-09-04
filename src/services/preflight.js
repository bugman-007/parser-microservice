// src/services/preflight.js
// Phase 1: metadata-only preflight for PDF-compatible AI/PDF
// No heavy parsing; robust string scanning + naming contract checks.

import fs from "fs-extra";
import path from "path";

const PREFLIGHT_STRICT =
  (process.env.PREFLIGHT_STRICT || "false").toLowerCase() === "true";
const FINISH_TOKENS = ["foil", "emboss", "deboss", "spot_uv", "die_cut"];

// Strict naming: front|back_layer_{N}_{effect}
// where effect ∈ print | die_cut | spot_uv | foil_* | emboss | deboss
const LAYER_NAME_RX =
  /\b(front|back)_layer_([0-9]+)_(print|die_cut|spot_uv|emboss|deboss|foil_[a-z0-9_]+)\b/gi;

function readSlice(buf, max = 2 * 1024 * 1024) {
  // read up to 2MB for token scanning; enough to find headers/OCG/Separation names
  if (buf.length <= max) return buf.toString("latin1");
  return Buffer.concat([buf.subarray(0, max), Buffer.from("...")]).toString(
    "latin1"
  );
}

function uniqueLower(arr) {
  return Array.from(new Set(arr.map((s) => s.toLowerCase())));
}

function extractOCGNames(pdfText) {
  // OCG names often appear as /Name(Front…) or /Name (front_layer_0_print)
  // Also scan for canonical layer tokens directly.
  const names = [];
  // 1) Grab any explicit OCG Name entries
  const nameRx = /\/Name\s*\(([^\)]+)\)/g;
  let m;
  while ((m = nameRx.exec(pdfText))) {
    names.push(m[1]);
  }
  // 2) Also capture direct canonical tokens found anywhere (fallback)
  let t;
  while ((t = LAYER_NAME_RX.exec(pdfText))) {
    names.push(t[0]);
  }
  return uniqueLower(names);
}

function extractSeparationNames(pdfText) {
  // /Separation /FOIL_GOLD ... OR /Separation(FOIL_GOLD)
  const names = [];
  const rx1 = /\/Separation\s*\/([A-Za-z0-9_.-]+)/g;
  const rx2 = /\/Separation\s*\(([^\)]+)\)/g;
  let m;
  while ((m = rx1.exec(pdfText))) names.push(m[1]);
  while ((m = rx2.exec(pdfText))) names.push(m[1]);
  return uniqueLower(names);
}

function detectOverprint(pdfText) {
  // Most commonly present as /OP true or /op true in ExtGState dictionaries.
  // We only assert "present somewhere" in Phase 1 (metadata-level).
  const rx = /\/OP\s+true|\/op\s+true/gi;
  return rx.test(pdfText);
}

function detectPdfCompatibility(buf) {
  const head = buf
    .subarray(0, Math.min(buf.length, 32 * 1024))
    .toString("latin1");
  return head.includes("%PDF-"); // AI saved with "PDF compatible" usually starts with PDF header
}

function analyzeLayerContract(ocgNames) {
  const violations = [];
  const matched = [];
  const unmatched = [];

  for (const name of ocgNames) {
    const hit = name.match(LAYER_NAME_RX);
    if (hit && hit.length > 0) {
      matched.push(name);
    } else {
      // Only flag tokens that look like ours but break the pattern
      if (/^(front|back)|layer|foil|uv|emboss|deboss|die/i.test(name)) {
        unmatched.push(name);
      }
    }
  }

  if (matched.length === 0) {
    violations.push(
      "No canonical layer names found (front|back_layer_N_effect)."
    );
  }
  if (unmatched.length > 0) {
    violations.push(
      `Non-canonical layer names detected: ${uniqueLower(unmatched).join(", ")}`
    );
  }

  // Check index continuity per side (layer_0..N). Advisory in Phase 1.
  const indices = { front: new Set(), back: new Set() };
  for (const n of matched) {
    const m = n.match(/(front|back)_layer_([0-9]+)_/i);
    if (m) indices[m[1].toLowerCase()].add(parseInt(m[2], 10));
  }
  const continuityWarnings = [];
  for (const side of ["front", "back"]) {
    if (indices[side].size > 0) {
      const arr = Array.from(indices[side]).sort((a, b) => a - b);
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== i) {
          continuityWarnings.push(
            `${side}: layer indices should start at 0 and be contiguous`
          );
          break;
        }
      }
    }
  }

  return { violations, continuityWarnings, matched };
}

function inferRequestedFinishesFromLayers(ocgNames) {
  const want = new Set();
  for (const name of ocgNames) {
    const lower = name.toLowerCase();
    if (lower.includes("foil_")) want.add("foil");
    if (lower.includes("spot_uv")) want.add("spot_uv");
    if (lower.includes("emboss")) want.add("emboss");
    if (lower.includes("deboss")) want.add("deboss");
    if (lower.includes("die_cut")) want.add("die_cut");
  }
  return Array.from(want);
}

function mapSeparationsToFinishes(seps) {
  const map = { foil: [], spot_uv: [], emboss: [], deboss: [], die_cut: [] };
  for (const s of seps) {
    const v = s.toLowerCase();
    if (v.startsWith("foil")) map.foil.push(s);
    if (v === "spot_uv" || v === "uv" || v.includes("uv")) map.spot_uv.push(s);
    if (v === "emboss") map.emboss.push(s);
    if (v === "deboss") map.deboss.push(s);
    if (v === "die" || v === "die_cut" || v.includes("die"))
      map.die_cut.push(s);
  }
  return map;
}

export async function runPreflight(filePath) {
  const buf = await fs.readFile(filePath);
  const text = readSlice(buf);

  const result = {
    pass: false,
    violations: [],
    warnings: [],
    detected: {
      pdfCompatible: false,
      ocgPresent: false,
      ocgNames: [],
      separations: [],
      separationMap: {},
      overprintPresent: false,
      requestedFinishes: [],
    },
  };

  const checks = [];
  const addCheck = (
    id,
    description,
    expected,
    observed,
    pass,
    severity = "error"
  ) => {
    checks.push({ id, description, expected, observed, pass, severity });
    if (!pass && severity === "error") result.violations.push(description);
    if (!pass && severity === "warning") result.warnings.push(description);
  };
  result.checks = checks;

  // 1) PDF-compatible AI/PDF
  result.detected.pdfCompatible = detectPdfCompatibility(buf);
  addCheck(
    "pdf.compatible",
    "File must be PDF-compatible AI/PDF",
    "Header starts with %PDF-",
    result.detected.pdfCompatible ? "%PDF- present" : "Missing %PDF-",
    result.detected.pdfCompatible
  );

  // 2) OCG (layer) presence + names
  const hasOCGs = /\/OCProperties|\/OCGs/gi.test(text);
  result.detected.ocgPresent = hasOCGs;
  addCheck(
    "ocg.present",
    "PDF Optional Content Groups (layers) must be present",
    "OCProperties/OCGs dictionary exists",
    hasOCGs ? "OCG found" : "OCG not found",
    hasOCGs
  );
  const ocgNames = extractOCGNames(text);
  result.detected.ocgNames = ocgNames;

  // 3) Naming contract
  const { violations: nameViolations, continuityWarnings } =
    analyzeLayerContract(ocgNames);
  const nameOk = nameViolations.length === 0;
  addCheck(
    "naming.canonical",
    "Layer names must follow: (front|back)_layer_{index}_{effect}",
    "front|back_layer_0..N_(print|die_cut|spot_uv|emboss|deboss|foil_*)",
    nameOk
      ? "All canonical"
      : `Issues: ${uniqueLower(nameViolations).join(", ")}`,
    nameOk
  );
  if (continuityWarnings.length) {
    addCheck(
      "naming.continuity",
      "Layer indices per side should start at 0 and be contiguous",
      "front/back indices = 0..N without gaps",
      uniqueLower(continuityWarnings).join(" | "),
      false,
      "warning"
    );
  }
  result.violations.push(...nameViolations);
  result.warnings.push(...continuityWarnings);

  // 4) Separation color spaces (spot plates)
  const seps = extractSeparationNames(text);
  result.detected.separations = seps;
  if (seps.length === 0) {
    result.warnings.push(
      "No /Separation color spaces found. If the artwork includes finishes, they must be true spot colors."
    );
  }
  result.detected.separationMap = mapSeparationsToFinishes(seps);

  // 5) Requested finishes inferred from layer names
  const requested = inferRequestedFinishesFromLayers(ocgNames);
  result.detected.requestedFinishes = requested;

  // 6) Cross-check finishes vs separations
  for (const fin of requested) {
    if (fin === "foil") {
      const ok = result.detected.separationMap.foil.length > 0;
      // POC policy: treat missing FOIL_* separation as a WARNING (allow preview)
      addCheck(
        "sep.foil",
        "FOIL layers require FOIL_* spot separation(s)",
        "Separation: /FOIL_*",
        ok ? result.detected.separationMap.foil.join(", ") : "None",
        ok,
        "warning"
      );
    }
    if (fin === "spot_uv") {
      const ok = result.detected.separationMap.spot_uv.length > 0;
      // POC policy: treat missing SPOT_UV separation as a WARNING (allow preview)
      addCheck(
        "sep.uv",
        "SPOT_UV layers require UV spot separation",
        "Separation: /SPOT_UV (or /UV)",
        ok ? result.detected.separationMap.spot_uv.join(", ") : "None",
        ok,
        "warning"
      );
    }
    if (fin === "emboss") {
      const ok = result.detected.separationMap.emboss.length > 0;
      // keep as ERROR (emboss plate needed for accurate finishing intent)
      addCheck(
        "sep.emboss",
        "EMBOSS layers require EMBOSS spot separation",
        "Separation: /EMBOSS",
        ok ? "EMBOSS present" : "None",
        ok
      );
    }
    if (fin === "deboss") {
      const ok = result.detected.separationMap.deboss.length > 0;
      // keep as ERROR
      addCheck(
        "sep.deboss",
        "DEBOSS layers require DEBOSS spot separation",
        "Separation: /DEBOSS",
        ok ? "DEBOSS present" : "None",
        ok
      );
    }
    if (fin === "die_cut") {
      const ok = result.detected.separationMap.die_cut.length > 0;
      // keep as ERROR (die is critical for trim geometry)
      addCheck(
        "sep.die",
        "DIE_CUT layers require DIE/DIE_CUT spot separation",
        "Separation: /DIE or /DIE_CUT",
        ok ? result.detected.separationMap.die_cut.join(", ") : "None",
        ok
      );
    }
  }

  // 7) Overprint presence (advisory in Phase 1)
  result.detected.overprintPresent = detectOverprint(text);
  addCheck(
    "overprint.present",
    "Finishes should draw with overprint enabled",
    "Graphics state has /OP true or /op true",
    result.detected.overprintPresent ? "Overprint flag present" : "Not found",
    result.detected.overprintPresent,
    "warning"
  );

  // Final pass/fail: Phase 1 requires: PDF-compatible + OCG present + naming OK (no violations from naming) + finish/separation consistency
  const errorFailed = checks.some((c) => !c.pass && c.severity === "error");
  result.pass =
    result.detected.pdfCompatible && result.detected.ocgPresent && !errorFailed;

  // ADD: explicit expectations block (returned to client)
  result.expectations = {
    namingPattern: "(front|back)_layer_{index}_{effect}",
    allowedEffects: [
      "print",
      "die_cut",
      "spot_uv",
      "emboss",
      "deboss",
      "foil_*",
    ],
    pdfExport: [
      "Create PDF Compatible File",
      "Create Acrobat Layers from Top-level Layers",
    ],
    finishColor: "Finishes should be true spot (/Separation) colorants",
    overprint: "Finishes drawn with overprint enabled",
    dieRule: "Die is stroke-only on DIE/DIE_CUT spot separation",
    policy:
      "POC mode: missing FOIL_* and SPOT_UV separations are treated as warnings (allowed for preview); EMBOSS/DEBOSS/DIE remain errors.",
  };

  return result;
}

export async function writePreflight(jobDir, data) {
  const out = path.join(jobDir, "preflight.json");
  await fs.writeJson(out, data, { spaces: 2 });
  return out;
}

export async function writeLayers(jobDir, ocgNames = []) {
  const outPath = path.join(jobDir, "layers.json");
  const payload = {
    layers: Array.isArray(ocgNames) ? ocgNames : [],
    createdAt: new Date().toISOString(),
  };
  await fs.writeJson(outPath, payload, { spaces: 2 });
  return outPath;
}

export async function writePlates(
  jobDir,
  separations = [],
  separationMap = {}
) {
  const outPath = path.join(jobDir, "plates.json");
  const payload = {
    separations: Array.isArray(separations) ? separations : [],
    map:
      separationMap && typeof separationMap === "object" ? separationMap : {},
    createdAt: new Date().toISOString(),
  };
  await fs.writeJson(outPath, payload, { spaces: 2 });
  return outPath;
}
