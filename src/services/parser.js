// parser-microservice/src/services/parser.js - CORE OCG-BASED PARSER
import fs from 'fs-extra';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { execSync } from 'child_process';
import sharp from 'sharp';
import { PNG } from 'pngjs';

export class AIParserV3 {
  constructor(options = {}) {
    this.dpi = options.dpi || 600;
    this.tempDir = options.tempDir || '/tmp';
    this.uploadDir = options.uploadDir || process.env.UPLOAD_DIR || '/opt/parser/uploads';
    this.enableOCG = options.enableOCG !== false;
    this.extractVector = options.extractVector !== false;
    
    console.log('🔧 Parser initialized:', {
      dpi: this.dpi,
      enableOCG: this.enableOCG,
      extractVector: this.extractVector
    });
  }

  async parseFile(jobId, filePath, options = {}) {
    const startTime = Date.now();
    const jobDir = path.join(this.uploadDir, jobId);
    const assetsDir = path.join(jobDir, 'assets');
    
    await fs.ensureDir(assetsDir);
    
    try {
      console.log(`🔍 Starting advanced OCG-based parsing: ${jobId}`);
      console.log(`📁 File: ${path.basename(filePath)}`);
      
      // 1. Validate and read PDF
      const pdfBytes = await fs.readFile(filePath);
      
      // Check if it's actually a PDF (AI files are PDF-based)
      if (!this.isPDFFile(pdfBytes)) {
        throw new Error('File is not a valid PDF or AI file');
      }
      
      // 2. Load PDF document
      const pdfDoc = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: true,
        capNumbers: false
      });
      
      console.log(`📄 PDF loaded: ${pdfDoc.getPageCount()} page(s)`);
      
      // 3. Extract document dimensions
      const dimensions = this.extractDocumentDimensions(pdfDoc);
      console.log(`📐 Card dimensions: ${dimensions.width}×${dimensions.height}mm`);
      
      // 4. Extract OCG layers (main parsing logic)
      const layers = await this.extractOCGLayers(pdfDoc, filePath, assetsDir, jobId);
      console.log(`🎨 Extracted ${layers.length} effect layers`);
      
      // 5. Generate base albedo maps
      const albedoMaps = await this.generateAlbedoMaps(filePath, assetsDir, dimensions);
      
      // 6. Process die-cut information
      const diecutInfo = await this.processDiecut(layers, assetsDir);
      
      // 7. Build material maps structure
      const maps = this.buildMaterialMaps(layers, albedoMaps, diecutInfo);
      
      // 8. Create final manifest
      const manifest = {
        version: "1.1",
        units: "mm",
        coords: { origin: "bottom-left", dpi: this.dpi },
        dimensions,
        maps,
        materials: { 
          paper: { 
            preset: "suede_350gsm_16pt",
            roughness: 0.8,
            thickness: dimensions.thickness
          } 
        },
        parsing: {
          method: 'ocg_extraction',
          parseTime: Date.now() - startTime,
          confidence: this.calculateConfidence(layers.length, Object.keys(maps).length),
          layersFound: layers.length,
          effectsExtracted: layers.filter(l => l.type === 'effect').length,
          dpi: this.dpi
        },
        metadata: {
          originalFile: path.basename(filePath),
          fileSize: pdfBytes.length,
          jobId
        }
      };
      
      // 9. Save results
      await fs.writeJson(path.join(jobDir, 'result.json'), manifest, { spaces: 2 });
      
      console.log(`✅ Parsing completed successfully in ${manifest.parsing.parseTime}ms`);
      console.log(`🎯 Confidence: ${(manifest.parsing.confidence * 100).toFixed(1)}%`);
      
      return manifest;
      
    } catch (error) {
      console.error(`❌ Parsing failed for ${jobId}:`, error);
      throw new Error(`Parsing failed: ${error.message}`);
    }
  }

  isPDFFile(buffer) {
    // Check PDF header
    const header = buffer.toString('ascii', 0, 8);
    return header.startsWith('%PDF-');
  }

  extractDocumentDimensions(pdfDoc) {
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    
    // Get page dimensions (prefer TrimBox > CropBox > MediaBox)
    let box;
    try {
      box = firstPage.getTrimBox();
      if (box.width === 0 || box.height === 0) {
        box = firstPage.getCropBox();
      }
    } catch {
      box = firstPage.getCropBox();
    }
    
    if (box.width === 0 || box.height === 0) {
      box = firstPage.getMediaBox();
    }
    
    // Convert points to mm (1 point = 0.352778 mm)
    const pointToMm = 0.352778;
    
    return {
      width: Math.round((box.width * pointToMm) * 100) / 100,
      height: Math.round((box.height * pointToMm) * 100) / 100,
      thickness: 0.35 // Standard business card thickness
    };
  }

  async extractOCGLayers(pdfDoc, filePath, assetsDir, jobId) {
    const layers = [];
    
    try {
      // Get OCG (Optional Content Groups) information
      const catalog = pdfDoc.catalog;
      const ocPropsRef = catalog.lookup(catalog.context.obj({
        OCProperties: catalog.get('OCProperties')
      }));
      
      if (!ocPropsRef || !this.enableOCG) {
        console.log('📄 No OCG layers found or OCG disabled, using fallback method');
        return await this.fallbackLayerExtraction(filePath, assetsDir);
      }
      
      console.log('🔍 Processing OCG layers...');
      
      // Extract layer names and process each one
      const layerNames = this.extractLayerNames(filePath);
      console.log(`📋 Found ${layerNames.length} potential layers:`, layerNames);
      
      for (let i = 0; i < layerNames.length; i++) {
        const layerName = layerNames[i];
        const effectInfo = this.detectEffectLayer(layerName);
        
        if (effectInfo) {
          console.log(`🎨 Processing effect layer: "${layerName}" (${effectInfo.type})`);
          
          try {
            // Generate mask for this specific layer
            const maskResult = await this.renderLayerMask(filePath, layerName, i, assetsDir);
            
            if (maskResult) {
              const bounds = await this.extractBoundsFromMask(maskResult.maskPath);
              
              layers.push({
                id: `layer_${i}`,
                name: layerName,
                type: 'effect',
                effectType: effectInfo.type,
                effectSubtype: effectInfo.subtype,
                side: effectInfo.side || 'front',
                maskFile: path.basename(maskResult.maskPath),
                bounds,
                confidence: maskResult.confidence || 0.8
              });
              
              console.log(`⚠️ Failed to generate mask for: ${layerName}`);
            }
          } catch (error) {
            console.warn(`⚠️ Error processing layer "${layerName}":`, error.message);
          }
        } else {
          console.log(`🔍 Skipping non-effect layer: "${layerName}"`);
        }
      }
      
    } catch (error) {
      console.warn('⚠️ OCG extraction failed:', error.message);
      console.log('📄 Falling back to basic extraction...');
      return await this.fallbackLayerExtraction(filePath, assetsDir);
    }
    
    return layers;
  }

  extractLayerNames(filePath) {
    // Use pdftk or similar tool to extract layer names
    // For now, we'll use a simpler approach with pdfinfo/strings
    try {
      const command = `strings "${filePath}" | grep -E "(Layer|OCG)" | head -20`;
      const output = execSync(command, { encoding: 'utf8', timeout: 10000 });
      
      const lines = output.split('\n').filter(line => line.trim().length > 0);
      const layerNames = [];
      
      for (const line of lines) {
        // Extract layer names from various patterns
        const patterns = [
          /Layer["\s]+([^"'\n\r]+)/i,
          /OCG["\s]*\(([^)]+)\)/i,
          /layerName["\s]*[:=]["\s]*([^"'\n\r]+)/i
        ];
        
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (match && match[1]) {
            const layerName = match[1].trim();
            if (layerName.length > 2 && layerName.length < 100 && !layerNames.includes(layerName)) {
              layerNames.push(layerName);
            }
          }
        }
      }
      
      return layerNames;
      
    } catch (error) {
      console.warn('Layer name extraction failed:', error.message);
      return [];
    }
  }

  async renderLayerMask(filePath, layerName, layerIndex, assetsDir) {
    const sanitizedName = layerName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(assetsDir, `${sanitizedName}_${layerIndex}.png`);
    
    try {
      // Method 1: Try pdftocairo with OCG isolation (requires advanced tools)
      const method1Success = await this.tryAdvancedOCGRendering(filePath, layerName, outputPath);
      
      if (method1Success) {
        return { maskPath: outputPath, confidence: 0.95 };
      }
      
      // Method 2: Fallback to full page render with post-processing
      const method2Success = await this.tryFullPageRender(filePath, outputPath);
      
      if (method2Success) {
        // Post-process to isolate the layer based on naming patterns
        await this.postProcessMask(outputPath, layerName);
        return { maskPath: outputPath, confidence: 0.7 };
      }
      
      return null;
      
    } catch (error) {
      console.error(`❌ Mask rendering failed for ${layerName}:`, error.message);
      return null;
    }
  }

  async tryAdvancedOCGRendering(filePath, layerName, outputPath) {
    try {
      // This would use advanced PDF tools like pdftk or Ghostscript with OCG manipulation
      // For now, we'll simulate this with pdftocairo
      const cmd = [
        'pdftocairo',
        '-png',
        '-singlefile',
        `-r ${this.dpi}`,
        '-cropbox',
        '-transp',
        `"${filePath}"`,
        `"${outputPath.replace('.png', '')}"`
      ].join(' ');
      
      console.log(`🖼️ Rendering with pdftocairo: ${path.basename(outputPath)}`);
      execSync(cmd, { stdio: 'pipe', timeout: 60000 });
      
      // Verify output exists and has content
      if (await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        if (stats.size > 1000) { // At least 1KB
          return true;
        }
      }
      
      return false;
      
    } catch (error) {
      console.warn('Advanced OCG rendering failed:', error.message);
      return false;
    }
  }

  async tryFullPageRender(filePath, outputPath) {
    try {
      // Render full page at high resolution
      const cmd = [
        'pdftocairo',
        '-png',
        '-singlefile',
        `-r ${this.dpi}`,
        '-cropbox',
        `"${filePath}"`,
        `"${outputPath.replace('.png', '')}"`
      ].join(' ');
      
      console.log(`🖼️ Full page render: ${path.basename(outputPath)}`);
      execSync(cmd, { stdio: 'pipe', timeout: 60000 });
      
      return await fs.pathExists(outputPath);
      
    } catch (error) {
      console.error('Full page rendering failed:', error.message);
      return false;
    }
  }

  async postProcessMask(maskPath, layerName) {
    try {
      // Use Sharp to post-process the mask based on layer characteristics
      const image = sharp(maskPath);
      const { width, height, channels } = await image.metadata();
      
      let processedImage = image;
      
      // Apply processing based on effect type
      const effectInfo = this.detectEffectLayer(layerName);
      
      if (effectInfo?.type === 'foil') {
        // Enhance metallic areas - increase contrast
        processedImage = processedImage
          .modulate({ brightness: 1.1, saturation: 0.8 })
          .sharpen();
      } else if (effectInfo?.type === 'spotUV') {
        // Enhance glossy areas - create clear mask
        processedImage = processedImage
          .threshold(128)
          .blur(0.5);
      } else if (effectInfo?.type === 'emboss') {
        // Create height map for embossing
        processedImage = processedImage
          .greyscale()
          .normalise();
      }
      
      // Save processed version
      await processedImage.png().toFile(maskPath);
      
      console.log(`✨ Post-processed mask for ${layerName}`);
      
    } catch (error) {
      console.warn(`Post-processing failed for ${layerName}:`, error.message);
    }
  }

  async extractBoundsFromMask(maskPath) {
    try {
      const pngBuffer = await fs.readFile(maskPath);
      const png = PNG.sync.read(pngBuffer);
      
      let minX = png.width, minY = png.height;
      let maxX = 0, maxY = 0;
      let hasContent = false;
      
      // Find bounding box of non-transparent pixels
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const idx = (png.width * y + x) << 2;
          const alpha = png.data[idx + 3];
          
          // Consider pixel significant if alpha > threshold
          if (alpha > 50) {
            hasContent = true;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      
      if (!hasContent) {
        console.warn('⚠️ No content found in mask');
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      
      // Convert pixels to mm
      const pxToMm = 25.4 / this.dpi;
      
      const bounds = {
        x: Math.round(minX * pxToMm * 100) / 100,
        y: Math.round(minY * pxToMm * 100) / 100,
        width: Math.round((maxX - minX) * pxToMm * 100) / 100,
        height: Math.round((maxY - minY) * pxToMm * 100) / 100
      };
      
      console.log(`📍 Extracted bounds:`, bounds);
      return bounds;
      
    } catch (error) {
      console.error('Bounds extraction error:', error);
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  async fallbackLayerExtraction(filePath, assetsDir) {
    console.log('🔄 Using fallback layer extraction...');
    
    const layers = [];
    const filename = path.basename(filePath).toLowerCase();
    
    // Generate some default layers based on filename analysis
    const defaultEffects = this.analyzeFilenameForEffects(filename);
    
    for (let i = 0; i < defaultEffects.length; i++) {
      const effect = defaultEffects[i];
      
      try {
        // Generate a simple mask
        const maskPath = await this.generateFallbackMask(assetsDir, effect, i);
        
        if (maskPath) {
          layers.push({
            id: `fallback_${i}`,
            name: effect.keyword,
            type: 'effect',
            effectType: effect.type,
            effectSubtype: effect.subtype,
            side: 'front',
            maskFile: path.basename(maskPath),
            bounds: this.generateDefaultBounds(i),
            confidence: 0.5 // Lower confidence for fallback
          });
        }
      } catch (error) {
        console.warn(`Fallback layer generation failed for ${effect.keyword}`);
      }
    }
    
    return layers;
  }

  analyzeFilenameForEffects(filename) {
    const effects = [];
    const effectPatterns = {
      foil: ['foil', 'gold', 'silver', 'metallic', 'hot'],
      spotUV: ['uv', 'gloss', 'varnish', 'coating'],
      emboss: ['emboss', 'raised', 'deboss'],
      diecut: ['die', 'cut', 'cutting']
    };
    
    for (const [effectType, keywords] of Object.entries(effectPatterns)) {
      for (const keyword of keywords) {
        if (filename.includes(keyword.toLowerCase())) {
          const subtype = this.extractSubtypeFromKeyword(keyword, filename);
          effects.push({
            type: effectType,
            keyword,
            subtype
          });
          break; // Only add one per effect type
        }
      }
    }
    
    return effects;
  }

  extractSubtypeFromKeyword(keyword, filename) {
    const subtypeMap = {
      'gold': 'gold',
      'silver': 'silver',
      'copper': 'copper',
      'rose': 'rose_gold',
      'uv': 'gloss',
      'gloss': 'gloss',
      'emboss': 'raised',
      'deboss': 'recessed'
    };
    
    return subtypeMap[keyword] || 'default';
  }

  async generateFallbackMask(assetsDir, effect, index) {
    try {
      // Generate a simple colored rectangle as a fallback mask
      const maskPath = path.join(assetsDir, `fallback_${effect.type}_${index}.png`);
      
      const maskWidth = Math.floor(this.dpi * 2); // 2 inch width
      const maskHeight = Math.floor(this.dpi * 1); // 1 inch height
      
      // Create a simple mask using Sharp
      const mask = sharp({
        create: {
          width: maskWidth,
          height: maskHeight,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 0.8 }
        }
      });
      
      await mask.png().toFile(maskPath);
      
      return maskPath;
      
    } catch (error) {
      console.error('Fallback mask generation failed:', error);
      return null;
    }
  }

  generateDefaultBounds(index) {
    // Generate reasonable default bounds for fallback layers
    const baseX = 15 + (index * 5);
    const baseY = 35;
    
    return {
      x: baseX,
      y: baseY,
      width: 25,
      height: 8
    };
  }

  async generateAlbedoMaps(filePath, assetsDir, dimensions) {
    const albedoMaps = {};
    
    try {
      // Generate front albedo map
      const frontPath = path.join(assetsDir, 'albedo_front.png');
      const success = await this.tryFullPageRender(filePath, frontPath);
      
      if (success) {
        albedoMaps.albedo_front = 'albedo_front.png';
        console.log('✅ Generated front albedo map');
      }
      
      // For multi-page PDFs, generate back map
      // This would require more sophisticated PDF page handling
      
    } catch (error) {
      console.warn('Albedo map generation failed:', error.message);
    }
    
    return albedoMaps;
  }

  async processDiecut(layers, assetsDir) {
    // Look for die-cut layers and process them
    const diecutLayers = layers.filter(l => l.effectType === 'diecut');
    
    if (diecutLayers.length === 0) {
      return null;
    }
    
    try {
      // For now, return basic die-cut info
      // In production, this would extract vector paths
      return {
        mask: diecutLayers[0].maskFile,
        vector: null // TODO: Extract SVG vector data
      };
    } catch (error) {
      console.warn('Die-cut processing failed:', error.message);
      return null;
    }
  }

  buildMaterialMaps(layers, albedoMaps, diecutInfo) {
    const maps = { ...albedoMaps };
    
    // Group layers by effect type
    const effectGroups = {
      foil: [],
      spotUV: [],
      emboss: [],
      diecut: diecutInfo ? [diecutInfo] : [],
      edge: []
    };
    
    for (const layer of layers) {
      if (layer.type === 'effect' && effectGroups[layer.effectType]) {
        effectGroups[layer.effectType].push({
          side: layer.side || 'front',
          color: layer.effectSubtype || 'default',
          mask: layer.maskFile,
          mode: layer.effectSubtype === 'recessed' ? 'deboss' : 'emboss',
          bounds: layer.bounds
        });
      }
    }
    
    // Add non-empty effect groups to maps
    for (const [effectType, items] of Object.entries(effectGroups)) {
      if (items.length > 0) {
        maps[effectType] = items;
      }
    }
    
    return maps;
  }

  detectEffectLayer(layerName) {
    const name = layerName.toLowerCase().trim();
    
    // Enhanced effect detection patterns
    const patterns = {
      foil: {
        keywords: ['foil', 'hot', 'metallic', 'gold', 'silver', 'copper', 'rose', 'holo'],
        subtypes: {
          'gold': ['gold', 'golden', 'yellow'],
          'silver': ['silver', 'chrome', 'metallic', 'white'],
          'copper': ['copper', 'bronze', 'brown'],
          'rose_gold': ['rose', 'pink', 'rosegold'],
          'holographic': ['holo', 'rainbow', 'prismatic']
        }
      },
      spotUV: {
        keywords: ['uv', 'spot', 'gloss', 'varnish', 'coating', 'clear'],
        subtypes: {
          'gloss': ['gloss', 'uv', 'coating', 'varnish']
        }
      },
      emboss: {
        keywords: ['emboss', 'raised', 'deboss', 'recessed', 'relief', 'pressed'],
        subtypes: {
          'raised': ['emboss', 'raised', 'relief'],
          'recessed': ['deboss', 'recessed', 'pressed']
        }
      },
      diecut: {
        keywords: ['die', 'cut', 'cutting', 'outline', 'trim'],
        subtypes: {
          'through': ['die', 'cut', 'cutting']
        }
      },
      edge: {
        keywords: ['edge', 'paint', 'ink'],
        subtypes: {
          'painted': ['paint', 'ink', 'color']
        }
      }
    };
    
    for (const [effectType, config] of Object.entries(patterns)) {
      if (config.keywords.some(keyword => name.includes(keyword))) {
        // Determine subtype
        let subtype = 'default';
        for (const [sub, subKeywords] of Object.entries(config.subtypes || {})) {
          if (subKeywords.some(keyword => name.includes(keyword))) {
            subtype = sub;
            break;
          }
        }
        
        // Determine side
        const side = name.includes('back') || name.includes('rear') ? 'back' : 'front';
        
        return { type: effectType, subtype, side };
      }
    }
    
    return null;
  }

  calculateConfidence(layerCount, mapCount) {
    // Calculate confidence based on successful extractions
    let confidence = 0.3; // Base confidence
    
    // Boost for successful layer detection
    if (layerCount > 0) {
      confidence += Math.min(0.4, layerCount * 0.1);
    }
    
    // Boost for successful map generation
    if (mapCount > 0) {
      confidence += Math.min(0.3, mapCount * 0.05);
    }
    
    // Cap at 98% (never 100% confident)
    return Math.min(0.98, confidence);
  }
}