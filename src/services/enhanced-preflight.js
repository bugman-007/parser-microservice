// src/services/enhanced-preflight.js - ENHANCED PREFLIGHT WITH STRICT NAMING VALIDATION
import fs from "fs-extra";
import path from "path";

/**
 * Enhanced Preflight Validation for OCG-based AI/PDF files
 * Implements strict naming convention validation: (front|back)_layer_{index}_{effect}
 */

// Strict naming pattern: (front|back)_layer_{index}_{effect}
const LAYER_NAME_PATTERN =
  /^(front|back)_layer_([0-9]+)_(print|foil_[a-z0-9_]+|spot_uv|emboss|deboss|die_cut)$/i;

// Allowed effects
const ALLOWED_EFFECTS = ["print", "spot_uv", "emboss", "deboss", "die_cut"];

// Foil variations
const FOIL_PATTERN = /^foil_[a-z0-9_]+$/i;

// Separation name mappings
const SEPARATION_MAPPINGS = {
  foil: /^(FOIL|foil)(_[A-Z0-9_]+)?$/i,
  spot_uv: /^(SPOT_UV|UV|spot_uv)$/i,
  emboss: /^(EMBOSS|emboss)$/i,
  deboss: /^(DEBOSS|deboss)$/i,
  die_cut: /^(DIE|DIE_CUT|die|die_cut)$/i,
};

// Enhanced PDF content reading with better encoding support
function readPDFSlice(buffer, maxSize = 3 * 1024 * 1024) {
  // Read up to 3MB for comprehensive token scanning
  if (buffer.length <= maxSize) {
    return buffer.toString("latin1");
  }

  // Read from beginning and end for better OCG detection
  const beginChunk = buffer.subarray(0, Math.floor(maxSize * 0.7));
  const endChunk = buffer.subarray(buffer.length - Math.floor(maxSize * 0.3));

  return Buffer.concat([beginChunk, Buffer.from("..."), endChunk]).toString(
    "latin1"
  );
}

function uniqueArray(arr) {
  return Array.from(new Set(arr.map((s) => s.toLowerCase().trim())));
}

/**
 * Enhanced OCG name extraction with multiple parsing methods
 */
function extractOCGNames(pdfText) {
  const names = new Set();

  // Method 1: Standard OCG Name entries /Name(layer_name) or /Name <layer_name>
  const namePatterns = [
    /\/Name\s*\(([^)]+)\)/g,
    /\/Name\s*<([^>]+)>/g,
    /\/Name\s+\/([^\s\/]+)/g,
    /\/Name\s+"([^"]+)"/g,
  ];

  namePatterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(pdfText)) !== null) {
      if (match[1]) {
        const cleanName = match[1].replace(/[\x00-\x1F\x7F]/g, "").trim();
        if (cleanName.length > 0) {
          names.add(cleanName);
        }
      }
    }
  });

  // Method 2: Direct layer name pattern matching (fallback)
  let directMatch;
  const directPattern = new RegExp(LAYER_NAME_PATTERN.source, "gi");
  while ((directMatch = directPattern.exec(pdfText)) !== null) {
    names.add(directMatch[0].trim());
  }

  // Method 3: OCG dictionary structure parsing
  const ocgDictPattern =
    /<<[^>]*\/Type\s*\/OCG[^>]*\/Name\s*\(([^)]+)\)[^>]*>>/g;
  let dictMatch;
  while ((dictMatch = ocgDictPattern.exec(pdfText)) !== null) {
    if (dictMatch[1]) {
      const cleanName = dictMatch[1].replace(/[\x00-\x1F\x7F]/g, "").trim();
      if (cleanName.length > 0) {
        names.add(cleanName);
      }
    }
  }

  return Array.from(names).filter((name) => name.length > 0);
}

/**
 * Enhanced separation name extraction
 */
function extractSeparationNames(pdfText) {
  const names = new Set();

  // Method 1: /Separation /NAME pattern
  const separationPattern1 = /\/Separation\s*\/([A-Za-z0-9_.-]+)/g;
  let match1;
  while ((match1 = separationPattern1.exec(pdfText)) !== null) {
    names.add(match1[1]);
  }

  // Method 2: /Separation (NAME) pattern
  const separationPattern2 = /\/Separation\s*\(([^)]+)\)/g;
  let match2;
  while ((match2 = separationPattern2.exec(pdfText)) !== null) {
    const cleanName = match2[1].replace(/[\x00-\x1F\x7F]/g, "").trim();
    if (cleanName.length > 0) {
      names.add(cleanName);
    }
  }

  // Method 3: ColorSpace separation arrays
  const colorSpacePattern =
    /\/ColorSpace\s*\[\s*\/Separation\s+\/([A-Za-z0-9_.-]+)/g;
  let match3;
  while ((match3 = colorSpacePattern.exec(pdfText)) !== null) {
    names.add(match3[1]);
  }

  return Array.from(names).filter((name) => name.length > 0);
}

/**
 * Enhanced overprint detection
 */
function detectOverprint(pdfText) {
  const overprintPatterns = [
    /\/OP\s+true/gi,
    /\/op\s+true/gi,
    /\/OPM\s+1/gi, // Overprint mode
    /"OP"\s+true/gi,
    /'OP'\s+true/gi,
  ];

  return overprintPatterns.some((pattern) => pattern.test(pdfText));
}

/**
 * Enhanced PDF compatibility detection
 */
function detectPDFCompatibility(buffer) {
  const header = buffer
    .subarray(0, Math.min(buffer.length, 1024))
    .toString("latin1");

  // Check PDF version and compatibility markers
  const hasPDFHeader = header.includes("%PDF-");
  const hasAIMarker =
    header.includes("Adobe Illustrator") || header.includes("%AI");
  const hasCompatibilityMarker =
    header.includes("PDF-1.") || header.includes("PDF-2.");

  if (!hasPDFHeader) {
    return { compatible: false, reason: "Missing PDF header" };
  }

  if (hasAIMarker && !hasCompatibilityMarker) {
    return {
      compatible: false,
      reason: "AI file not saved with PDF compatibility",
    };
  }

  // Check for PDF structure integrity
  const fullContent = buffer.toString("latin1");
  const hasXref = fullContent.includes("xref");
  const hasTrailer = fullContent.includes("trailer");
  const hasStartXref = fullContent.includes("startxref");
  const hasEOF = fullContent.includes("%%EOF");

  if (!hasXref || !hasTrailer || !hasStartXref) {
    return { compatible: false, reason: "Incomplete PDF structure" };
  }

  return { compatible: true, reason: "Valid PDF-compatible file" };
}

/**
 * Enhanced layer naming validation with detailed error reporting
 */
function analyzeLayerContract(ocgNames) {
  const result = {
    violations: [],
    warnings: [],
    validLayers: [],
    invalidLayers: [],
    layersByIndex: { front: new Map(), back: new Map() },
    effectCounts: { front: {}, back: {} },
  };

  // Analyze each layer name
  for (const name of ocgNames) {
    const match = name.match(LAYER_NAME_PATTERN);

    if (match) {
      const [fullMatch, side, indexStr, effect] = match;
      const index = parseInt(indexStr, 10);

      // Validate effect type
      const isValidEffect =
        ALLOWED_EFFECTS.includes(effect) || FOIL_PATTERN.test(effect);

      if (!isValidEffect) {
        result.violations.push(
          `Invalid effect "${effect}" in layer "${name}". Allowed: ${ALLOWED_EFFECTS.join(
            ", "
          )}, foil_*`
        );
        result.invalidLayers.push({ name, reason: "invalid_effect", effect });
        continue;
      }

      // Revised duplicate policy (relaxed):
      // - Allow multiple effects at the same index (e.g., print + spot_uv + multiple foil_*)
      // - Enforce uniqueness per (side, index, baseEffect)
      // - baseEffect := 'foil' for any 'foil_*', otherwise the exact effect ('print','spot_uv','emboss','deboss','die_cut')
      const baseEffect = effect.startsWith("foil_") ? "foil" : effect;

      // Ensure nested map: indices -> { byEffect: Map<baseEffect, Array<layerInfo>>, list: Array<layerInfo> }
      let indexBucket = result.layersByIndex[side].get(index);
      if (!indexBucket) {
        indexBucket = { byEffect: new Map(), list: [] };
        result.layersByIndex[side].set(index, indexBucket);
      }

      const existingForBase = indexBucket.byEffect.get(baseEffect) || [];

      // For non-foil effects, allow only one per (side,index)
      if (baseEffect !== "foil") {
        if (existingForBase.length > 0) {
          const conflict = existingForBase[0];
          result.violations.push(
            `Duplicate ${baseEffect} at ${side} index ${index}: "${name}" conflicts with "${conflict.name}"`
          );
          result.invalidLayers.push({
            name,
            reason: "duplicate_effect_index",
            conflictsWith: conflict.name,
          });
          continue;
        }
      }

      // For foil_* allow multiple distinct foil variants at the same (side,index).
      // If the exact same foil_* appears twice, flag as a WARNING (keep valid).
      if (baseEffect === "foil") {
        const exactDup = existingForBase.find((l) => l.effect === effect);
        if (exactDup) {
          result.warnings.push(
            `Duplicate foil "${effect}" at ${side} index ${index}; verify if intentional.`
          );
        }
      }

      // Valid layer — record it
      const layerInfo = { name, side, index, effect, isValid: true };
      result.validLayers.push(layerInfo);
      existingForBase.push(layerInfo);
      indexBucket.byEffect.set(baseEffect, existingForBase);
      indexBucket.list.push(layerInfo);

      //   result.layersByIndex[side].set(index, layerInfo);

      // Count effects per side
      if (!result.effectCounts[side][effect]) {
        result.effectCounts[side][effect] = 0;
      }
      result.effectCounts[side][effect]++;
    } else {
      // Check if it looks like it should follow our pattern but doesn't
      const looksLikeOurPattern =
        /^(front|back)|layer|foil|uv|emboss|deboss|die/i.test(name);

      if (looksLikeOurPattern) {
        result.violations.push(
          `Layer "${name}" appears to follow naming convention but is malformed. Expected: (front|back)_layer_{index}_{effect}`
        );
        result.invalidLayers.push({ name, reason: "malformed_pattern" });
      } else {
        // Generic layer that doesn't follow convention
        result.warnings.push(
          `Generic layer "${name}" doesn't follow naming convention and will be ignored`
        );
        result.invalidLayers.push({ name, reason: "generic_layer" });
      }
    }
  }

  // Check index continuity per side
  for (const side of ["front", "back"]) {
    const indices = Array.from(result.layersByIndex[side].keys()).sort(
      (a, b) => a - b
    );

    if (indices.length > 0) {
      // Check if indices start at 0
      if (indices[0] !== 0) {
        result.warnings.push(
          `${side} side: layer indices should start at 0, found starting at ${indices[0]}`
        );
      }

      // Check for gaps in indices
      for (let i = 0; i < indices.length; i++) {
        if (indices[i] !== i) {
          result.warnings.push(
            `${side} side: layer indices should be contiguous (0,1,2...), found gap at index ${i}. Indices: [${indices.join(
              ", "
            )}]`
          );
          break;
        }
      }
    }
  }

  // Validate effect combinations
  const validateEffectCombinations = (sideEffects, side) => {
    const hasMultipleFoils =
      Object.keys(sideEffects).filter((effect) => effect.startsWith("foil_"))
        .length > 1;
    if (hasMultipleFoils) {
      result.warnings.push(
        `${side} side: multiple foil types detected. Ensure each foil uses different spot separations.`
      );
    }

    if (sideEffects["emboss"] && sideEffects["deboss"]) {
      result.warnings.push(
        `${side} side: both emboss and deboss effects detected. This is unusual but allowed.`
      );
    }
  };

  validateEffectCombinations(result.effectCounts.front, "front");
  validateEffectCombinations(result.effectCounts.back, "back");

  return result;
}

/**
 * Map separation names to effect types
 */
function mapSeparationsToEffects(separations) {
  const mapping = {
    foil: [],
    spot_uv: [],
    emboss: [],
    deboss: [],
    die_cut: [],
    unmapped: [],
  };

  for (const sep of separations) {
    let mapped = false;

    for (const [effectType, pattern] of Object.entries(SEPARATION_MAPPINGS)) {
      if (pattern.test(sep)) {
        mapping[effectType].push(sep);
        mapped = true;
        break;
      }
    }

    if (!mapped) {
      mapping.unmapped.push(sep);
    }
  }

  return mapping;
}

/**
 * Infer requested finishes from layer names
 */
function inferRequestedFinishes(layerAnalysis) {
  const finishes = new Set();

  for (const layer of layerAnalysis.validLayers) {
    if (layer.effect.startsWith("foil_")) {
      finishes.add("foil");
    } else if (layer.effect !== "print") {
      finishes.add(layer.effect);
    }
  }

  return Array.from(finishes);
}

/**
 * MAIN ENHANCED PREFLIGHT FUNCTION
 */
export async function runEnhancedPreflight(filePath) {
  const buffer = await fs.readFile(filePath);
  const text = readPDFSlice(buffer);

  const result = {
    pass: false,
    violations: [],
    warnings: [],
    detected: {
      pdfCompatible: false,
      pdfCompatibilityInfo: {},
      ocgPresent: false,
      ocgNames: [],
      separations: [],
      separationMapping: {},
      overprintPresent: false,
      requestedFinishes: [],
      layerAnalysis: {},
    },
    checks: [],
    recommendations: [],
    fileInfo: {
      size: buffer.length,
      path: filePath,
      name: path.basename(filePath),
    },
  };

  const addCheck = (
    id,
    description,
    expected,
    observed,
    pass,
    severity = "error"
  ) => {
    const check = { id, description, expected, observed, pass, severity };
    result.checks.push(check);

    if (!pass) {
      if (severity === "error") {
        result.violations.push(
          `${description}: Expected ${expected}, got ${observed}`
        );
      } else if (severity === "warning") {
        result.warnings.push(
          `${description}: Expected ${expected}, got ${observed}`
        );
      }
    }
  };

  console.log("🔍 Running enhanced preflight validation...");

  // 1. Enhanced PDF Compatibility Check
  const compatibility = detectPDFCompatibility(buffer);
  result.detected.pdfCompatible = compatibility.compatible;
  result.detected.pdfCompatibilityInfo = compatibility;

  addCheck(
    "pdf.compatibility",
    "File must be PDF-compatible AI/PDF",
    "Valid PDF structure with compatibility markers",
    compatibility.reason,
    compatibility.compatible
  );

  // 2. Enhanced OCG Detection
  const hasOCGProperties = /\/OCProperties|\/OCGs/gi.test(text);
  result.detected.ocgPresent = hasOCGProperties;

  addCheck(
    "ocg.presence",
    "PDF must contain Optional Content Groups (layers)",
    "OCProperties/OCGs dictionary present",
    hasOCGProperties ? "OCG structures found" : "No OCG structures found",
    hasOCGProperties
  );

  // 3. Enhanced OCG Name Extraction
  const ocgNames = extractOCGNames(text);
  result.detected.ocgNames = ocgNames;

  console.log(`📋 Found ${ocgNames.length} OCG layer names:`, ocgNames);

  // 4. Enhanced Layer Naming Analysis
  const layerAnalysis = analyzeLayerContract(ocgNames);
  result.detected.layerAnalysis = layerAnalysis;

  // Add violations and warnings from layer analysis
  result.violations.push(...layerAnalysis.violations);
  result.warnings.push(...layerAnalysis.warnings);

  const namingCompliant = layerAnalysis.violations.length === 0;
  addCheck(
    "naming.compliance",
    "All layers must follow strict naming convention",
    "(front|back)_layer_{index}_{effect} with valid effects",
    namingCompliant
      ? `${layerAnalysis.validLayers.length} valid layers found`
      : `${layerAnalysis.violations.length} naming violations`,
    namingCompliant
  );

  // 5. Layer Index Continuity (Warning Level)
  const hasIndexWarnings = layerAnalysis.warnings.some((w) =>
    w.includes("indices")
  );
  if (hasIndexWarnings) {
    addCheck(
      "naming.continuity",
      "Layer indices should be contiguous starting from 0",
      "front/back_layer_0, front/back_layer_1, etc.",
      "Index gaps or non-zero start detected",
      false,
      "warning"
    );
  }

  // 6. Enhanced Separation Detection
  const separations = extractSeparationNames(text);
  result.detected.separations = separations;
  result.detected.separationMapping = mapSeparationsToEffects(separations);

  console.log(`🎨 Found ${separations.length} separation colors:`, separations);

  if (separations.length === 0) {
    addCheck(
      "separations.presence",
      "Finish effects should use spot color separations",
      "At least one /Separation color space for finishes",
      "No separation color spaces found",
      false,
      "warning"
    );
  }

  // 7. Infer Requested Finishes
  const requestedFinishes = inferRequestedFinishes(layerAnalysis);
  result.detected.requestedFinishes = requestedFinishes;

  console.log(`✨ Requested finishes: ${requestedFinishes.join(", ")}`);

  // 8. Cross-validate Finishes vs Separations
  for (const finish of requestedFinishes) {
    const separationList = result.detected.separationMapping[finish] || [];
    const hasRequiredSeparation = separationList.length > 0;

    // Different policies for different effects
    if (finish === "foil") {
      addCheck(
        `separations.${finish}`,
        `FOIL effects should have corresponding spot separations`,
        "FOIL_* separation color space",
        hasRequiredSeparation
          ? `Found: ${separationList.join(", ")}`
          : "No FOIL_* separations found",
        hasRequiredSeparation,
        "warning" // POC mode: warning for foil
      );
    } else if (finish === "spot_uv") {
      addCheck(
        `separations.${finish}`,
        `SPOT_UV effects should have corresponding spot separations`,
        "SPOT_UV or UV separation color space",
        hasRequiredSeparation
          ? `Found: ${separationList.join(", ")}`
          : "No UV separations found",
        hasRequiredSeparation,
        "warning" // POC mode: warning for UV
      );
    } else if (finish === "emboss") {
      addCheck(
        `separations.${finish}`,
        `EMBOSS effects must have corresponding spot separations`,
        "EMBOSS separation color space",
        hasRequiredSeparation
          ? `Found: ${separationList.join(", ")}`
          : "No EMBOSS separation found",
        hasRequiredSeparation,
        "error" // Keep as error - emboss needs precise control
      );
    } else if (finish === "deboss") {
      addCheck(
        `separations.${finish}`,
        `DEBOSS effects must have corresponding spot separations`,
        "DEBOSS separation color space",
        hasRequiredSeparation
          ? `Found: ${separationList.join(", ")}`
          : "No DEBOSS separation found",
        hasRequiredSeparation,
        "error" // Keep as error - deboss needs precise control
      );
    } else if (finish === "die_cut") {
      addCheck(
        `separations.${finish}`,
        `DIE_CUT effects must have corresponding spot separations`,
        "DIE or DIE_CUT separation color space",
        hasRequiredSeparation
          ? `Found: ${separationList.join(", ")}`
          : "No DIE separations found",
        hasRequiredSeparation,
        "error" // Keep as error - die cut is critical for geometry
      );
    }
  }

  // 9. Overprint Detection
  result.detected.overprintPresent = detectOverprint(text);
  addCheck(
    "overprint.presence",
    "Finish effects should use overprint for proper color mixing",
    "Graphics state with /OP true or /op true",
    result.detected.overprintPresent
      ? "Overprint flags found"
      : "No overprint flags detected",
    result.detected.overprintPresent,
    "warning" // Advisory for now
  );

  // 10. File Size and Structure Validation
  const fileSizeMB = buffer.length / (1024 * 1024);
  addCheck(
    "file.size",
    "File size should be reasonable for processing",
    "< 100MB",
    `${fileSizeMB.toFixed(1)}MB`,
    fileSizeMB < 100
  );

  // 11. Advanced Structure Validation
  const hasValidStructure =
    text.includes("xref") &&
    text.includes("trailer") &&
    text.includes("startxref");

  addCheck(
    "pdf.structure",
    "PDF must have valid internal structure",
    "Complete xref table and trailer",
    hasValidStructure ? "Valid structure" : "Incomplete structure",
    hasValidStructure
  );

  // 12. Generate Recommendations
  result.recommendations = generateRecommendations(result);

  // Final Pass/Fail Decision
  const errorCount = result.checks.filter(
    (c) => !c.pass && c.severity === "error"
  ).length;
  const criticalChecks = [
    "pdf.compatibility",
    "ocg.presence",
    "naming.compliance",
  ];
  const criticalFailures = result.checks.filter(
    (c) => criticalChecks.includes(c.id) && !c.pass
  ).length;

  result.pass = errorCount === 0 || (criticalFailures === 0 && errorCount <= 2); // Allow minor errors if critical checks pass

  // Enhanced expectations for client
  result.expectations = {
    namingPattern: "(front|back)_layer_{index}_{effect}",
    indexPolicy:
      "Multiple effects allowed at the same {index} (e.g., print + spot_uv + foil_*). Uniqueness is enforced per (side,index,baseEffect). baseEffect='foil' for any foil_*.",
    uniquenessRules: {
      print: "max 1 per (side,index)",
      spot_uv: "max 1 per (side,index)",
      emboss: "max 1 per (side,index)",
      deboss: "max 1 per (side,index)",
      die_cut: "max 1 per (side,index)",
      foil: "multiple foil_* variants allowed per (side,index); exact duplicates are warnings",
    },
    allowedEffects: [
      "print",
      "spot_uv",
      "emboss",
      "deboss",
      "die_cut",
      "foil_*",
    ],
    exportHints: [
      "Create PDF Compatible File",
      "Create Acrobat Layers from Top-level Layers",
    ],

    // namingPattern: "(front|back)_layer_{index}_{effect}",
    // allowedEffects: [...ALLOWED_EFFECTS, "foil_*"],
    // exampleLayers: [
    //   "front_layer_0_print",
    //   "front_layer_1_foil_gold",
    //   "front_layer_2_spot_uv",
    //   "front_layer_3_emboss",
    // ],
    // pdfExport: [
    //   "Create PDF Compatible File ✓",
    //   "Create Acrobat Layers from Top-level Layers ✓",
    // ],
    // finishRequirements: {
    //   foil: "Use spot color separations named FOIL_* (warning in POC mode)",
    //   spot_uv:
    //     "Use spot color separation named SPOT_UV or UV (warning in POC mode)",
    //   emboss: "Use spot color separation named EMBOSS (required)",
    //   deboss: "Use spot color separation named DEBOSS (required)",
    //   die_cut: "Use spot color separation named DIE or DIE_CUT (required)",
    // },
    // overprint: "Enable overprint for all finish effects",
    // indexing: "Layer indices start at 0 and should be contiguous per side",
  };

  console.log(
    `📊 Enhanced preflight result: ${result.pass ? "✅ PASS" : "❌ FAIL"}`
  );
  console.log(`   Errors: ${errorCount}, Warnings: ${result.warnings.length}`);
  console.log(
    `   Valid layers: ${layerAnalysis.validLayers.length}/${ocgNames.length}`
  );

  return result;
}

/**
 * Generate actionable recommendations based on preflight results
 */
function generateRecommendations(result) {
  const recommendations = [];

  // PDF Compatibility recommendations
  if (!result.detected.pdfCompatible) {
    recommendations.push({
      type: "critical",
      title: "Fix PDF Compatibility",
      description:
        "In Adobe Illustrator, go to File > Save As > Adobe PDF and ensure 'Create PDF Compatible File' is checked.",
      action: "Re-save with PDF compatibility enabled",
    });
  }

  // OCG recommendations
  if (!result.detected.ocgPresent) {
    recommendations.push({
      type: "critical",
      title: "Enable Layer Export",
      description:
        "In Adobe Illustrator PDF export options, check 'Create Acrobat Layers from Top-Level Layers'.",
      action: "Enable layer export in PDF options",
    });
  }

  // Naming recommendations
  const layerAnalysis = result.detected.layerAnalysis;
  if (layerAnalysis.invalidLayers?.length > 0) {
    const invalidNames = layerAnalysis.invalidLayers
      .map((l) => l.name)
      .join('", "');
    recommendations.push({
      type: "error",
      title: "Fix Layer Naming",
      description: `Rename layers to follow pattern: (front|back)_layer_{index}_{effect}`,
      action: `Rename invalid layers: "${invalidNames}"`,
      examples: [
        "front_layer_0_print",
        "front_layer_1_foil_gold",
        "front_layer_2_spot_uv",
      ],
    });
  }

  // Separation recommendations
  for (const finish of result.detected.requestedFinishes) {
    const separations = result.detected.separationMapping[finish] || [];
    if (separations.length === 0) {
      const isRequired = ["emboss", "deboss", "die_cut"].includes(finish);
      recommendations.push({
        type: isRequired ? "error" : "warning",
        title: `Add ${finish.toUpperCase()} Spot Color`,
        description: `Create a spot color separation for ${finish} effects to ensure accurate printing.`,
        action: `Add spot color named "${finish
          .toUpperCase()
          .replace("_", "_")}" to your document`,
        severity: isRequired ? "required" : "recommended",
      });
    }
  }

  // Overprint recommendations
  if (
    !result.detected.overprintPresent &&
    result.detected.requestedFinishes.length > 0
  ) {
    recommendations.push({
      type: "warning",
      title: "Enable Overprint",
      description:
        "Finish effects should use overprint to ensure proper color interaction with underlying elements.",
      action: "Set overprint to ON for all finish effect objects",
    });
  }

  // Index continuity recommendations
  const hasIndexWarnings = result.warnings.some((w) => w.includes("indices"));
  if (hasIndexWarnings) {
    recommendations.push({
      type: "warning",
      title: "Fix Layer Index Continuity",
      description:
        "Layer indices should start at 0 and be contiguous (0,1,2...) for each side.",
      action: "Renumber layers to ensure continuous indexing",
    });
  }

  return recommendations;
}

/**
 * Write enhanced preflight results
 */
export async function writeEnhancedPreflight(jobDir, data) {
  const outputPath = path.join(jobDir, "preflight.json");

  // Add timestamp and version info
  const enhancedData = {
    ...data,
    version: "2.0",
    generatedAt: new Date().toISOString(),
    preflightEngine: "enhanced_ocg_validator",
  };

  await fs.writeJson(outputPath, enhancedData, { spaces: 2 });

  console.log(`📝 Enhanced preflight results written to: ${outputPath}`);
  return outputPath;
}

/**
 * Write enhanced layer analysis
 */
export async function writeEnhancedLayers(jobDir, layerAnalysis) {
  const outputPath = path.join(jobDir, "layers.json");

  const layersData = {
    version: "2.0",
    validLayers: layerAnalysis.validLayers || [],
    invalidLayers: layerAnalysis.invalidLayers || [],
    layersByIndex: {
      front: Array.from(layerAnalysis.layersByIndex?.front?.values() || []),
      back: Array.from(layerAnalysis.layersByIndex?.back?.values() || []),
    },
    effectCounts: layerAnalysis.effectCounts || { front: {}, back: {} },
    summary: {
      totalLayers:
        (layerAnalysis.validLayers?.length || 0) +
        (layerAnalysis.invalidLayers?.length || 0),
      validCount: layerAnalysis.validLayers?.length || 0,
      invalidCount: layerAnalysis.invalidLayers?.length || 0,
      frontLayers: layerAnalysis.layersByIndex?.front?.size || 0,
      backLayers: layerAnalysis.layersByIndex?.back?.size || 0,
    },
    createdAt: new Date().toISOString(),
  };

  await fs.writeJson(outputPath, layersData, { spaces: 2 });

  console.log(`📋 Enhanced layer analysis written to: ${outputPath}`);
  return outputPath;
}

/**
 * Write enhanced separation analysis
 */
export async function writeEnhancedSeparations(
  jobDir,
  separations,
  separationMapping
) {
  const outputPath = path.join(jobDir, "separations.json");

  const separationsData = {
    version: "2.0",
    separations: Array.isArray(separations) ? separations : [],
    mapping: separationMapping || {},
    analysis: {
      totalSeparations: separations?.length || 0,
      mappedSeparations: Object.values(separationMapping || {}).flat().length,
      unmappedSeparations: separationMapping?.unmapped || [],
      effectCoverage: {
        foil: (separationMapping?.foil?.length || 0) > 0,
        spot_uv: (separationMapping?.spot_uv?.length || 0) > 0,
        emboss: (separationMapping?.emboss?.length || 0) > 0,
        deboss: (separationMapping?.deboss?.length || 0) > 0,
        die_cut: (separationMapping?.die_cut?.length || 0) > 0,
      },
    },
    createdAt: new Date().toISOString(),
  };

  await fs.writeJson(outputPath, separationsData, { spaces: 2 });

  console.log(`🎨 Enhanced separation analysis written to: ${outputPath}`);
  return outputPath;
}
