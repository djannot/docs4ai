#!/usr/bin/env node
/**
 * Icon Generation Script
 * 
 * This script generates platform-specific icons from the SVG source.
 * 
 * Prerequisites:
 *   brew install librsvg imagemagick  # macOS
 *   apt-get install librsvg2-bin imagemagick  # Linux
 * 
 * Usage:
 *   node scripts/generate-icons.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');
const svgPath = path.join(assetsDir, 'icon.svg');

// Sizes needed for different platforms
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];

console.log('Generating icons from SVG...');

// Check if rsvg-convert is available
try {
    execSync('which rsvg-convert', { stdio: 'pipe' });
} catch {
    console.error('Error: rsvg-convert not found. Install with:');
    console.error('  macOS: brew install librsvg');
    console.error('  Linux: apt-get install librsvg2-bin');
    process.exit(1);
}

// Generate PNG files for each size
for (const size of sizes) {
    const outputPath = path.join(assetsDir, `icon-${size}.png`);
    try {
        execSync(`rsvg-convert -w ${size} -h ${size} "${svgPath}" -o "${outputPath}"`);
        console.log(`  Created: icon-${size}.png`);
    } catch (error) {
        console.error(`  Failed to create icon-${size}.png:`, error.message);
    }
}

// Create icon.png (512x512 for electron-builder)
try {
    execSync(`rsvg-convert -w 512 -h 512 "${svgPath}" -o "${path.join(assetsDir, 'icon.png')}"`);
    console.log('  Created: icon.png (512x512)');
} catch (error) {
    console.error('  Failed to create icon.png:', error.message);
}

// Try to create .icns for macOS (requires iconutil on macOS)
if (process.platform === 'darwin') {
    const iconsetDir = path.join(assetsDir, 'icon.iconset');
    
    try {
        // Create iconset directory
        if (!fs.existsSync(iconsetDir)) {
            fs.mkdirSync(iconsetDir);
        }
        
        // Generate required sizes for iconset
        const iconsetSizes = [
            { size: 16, scale: 1 },
            { size: 16, scale: 2 },
            { size: 32, scale: 1 },
            { size: 32, scale: 2 },
            { size: 128, scale: 1 },
            { size: 128, scale: 2 },
            { size: 256, scale: 1 },
            { size: 256, scale: 2 },
            { size: 512, scale: 1 },
            { size: 512, scale: 2 },
        ];
        
        for (const { size, scale } of iconsetSizes) {
            const actualSize = size * scale;
            const filename = scale === 1 
                ? `icon_${size}x${size}.png`
                : `icon_${size}x${size}@2x.png`;
            const outputPath = path.join(iconsetDir, filename);
            execSync(`rsvg-convert -w ${actualSize} -h ${actualSize} "${svgPath}" -o "${outputPath}"`);
        }
        
        // Convert to .icns
        execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(assetsDir, 'icon.icns')}"`);
        console.log('  Created: icon.icns (macOS)');
        
        // Clean up iconset directory
        fs.rmSync(iconsetDir, { recursive: true });
    } catch (error) {
        console.error('  Failed to create icon.icns:', error.message);
    }
}

// Try to create .ico for Windows (requires ImageMagick)
try {
    execSync('which convert', { stdio: 'pipe' });
    const icoSizes = [16, 32, 48, 256].map(s => path.join(assetsDir, `icon-${s}.png`)).join(' ');
    execSync(`convert ${icoSizes} "${path.join(assetsDir, 'icon.ico')}"`);
    console.log('  Created: icon.ico (Windows)');
} catch {
    console.log('  Skipped: icon.ico (ImageMagick not available)');
}

console.log('\nDone! Icons are in the assets/ directory.');
console.log('\nNote: electron-builder will automatically convert icon.png if .icns/.ico are missing.');
