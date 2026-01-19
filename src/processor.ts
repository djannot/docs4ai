import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface DocumentChunk {
    chunkId: string;
    content: string;
    section: string;
    headingHierarchy: string[];
    chunkIndex: number;
    totalChunks: number;
    url: string;
    hash: string;
}

export class ContentProcessor {
    private maxTokens = 1000;
    private minTokens = 150;
    private overlapPercent = 0.1;

    async readFile(filePath: string): Promise<string | null> {
        const ext = path.extname(filePath).toLowerCase();

        try {
            switch (ext) {
                case '.pdf':
                    return await this.readPdf(filePath);
                case '.doc':
                    return await this.readDoc(filePath);
                case '.docx':
                    return await this.readDocx(filePath);
                case '.html':
                case '.htm':
                    const html = fs.readFileSync(filePath, 'utf-8');
                    return this.stripHtml(html);
                default:
                    return fs.readFileSync(filePath, 'utf-8');
            }
        } catch (error) {
            console.error(`Error reading file ${filePath}:`, error);
            return null;
        }
    }

    private async readPdf(filePath: string): Promise<string> {
        try {
            const pdfParse = require('pdf-parse');
            const buffer = fs.readFileSync(filePath);
            const data = await pdfParse(buffer);
            return `# ${path.basename(filePath, '.pdf')}\n\n${data.text}`;
        } catch (error: any) {
            if (error.code === 'MODULE_NOT_FOUND') {
                console.warn(`PDF parsing not available for ${filePath}. Install pdf-parse for PDF support.`);
                return `# ${path.basename(filePath, '.pdf')}\n\n[PDF content - install pdf-parse for extraction]`;
            }
            throw error;
        }
    }

    private async readDoc(filePath: string): Promise<string> {
        try {
            const WordExtractor = require('word-extractor');
            const extractor = new WordExtractor();
            const extracted = await extractor.extract(filePath);
            const text = extracted.getBody();
            
            // Create content with filename as title
            let content = `# ${path.basename(filePath, '.doc')}\n\n`;
            
            // Clean up the text
            const cleanedText = text
                .replace(/\r\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            
            content += cleanedText;
            return content;
        } catch (error: any) {
            if (error.code === 'MODULE_NOT_FOUND') {
                console.warn(`DOC parsing not available for ${filePath}. Install word-extractor for DOC support.`);
                return `# ${path.basename(filePath, '.doc')}\n\n[DOC content - install word-extractor for extraction]`;
            }
            throw error;
        }
    }

    private async readDocx(filePath: string): Promise<string> {
        try {
            const mammoth = require('mammoth');
            const result = await mammoth.convertToHtml({ path: filePath });
            const html = result.value;
            
            // Log any warnings
            if (result.messages.length > 0) {
                console.log(`Mammoth warnings for ${filePath}: ${result.messages.map((m: any) => m.message).join(', ')}`);
            }
            
            // Create content with filename as title
            let content = `# ${path.basename(filePath, '.docx')}\n\n`;
            
            // Strip HTML to get plain text
            content += this.stripHtml(html);
            
            // Clean up excessive line breaks
            content = content.replace(/\n{3,}/g, '\n\n').trim();
            
            return content;
        } catch (error: any) {
            if (error.code === 'MODULE_NOT_FOUND') {
                console.warn(`DOCX parsing not available for ${filePath}. Install mammoth for DOCX support.`);
                return `# ${path.basename(filePath, '.docx')}\n\n[DOCX content - install mammoth for extraction]`;
            }
            throw error;
        }
    }

    private stripHtml(html: string): string {
        return html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }

    generateHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private tokenize(text: string): string[] {
        return text.split(/(\s+)/).filter(token => token.length > 0);
    }

    chunkContent(content: string, filePath: string): DocumentChunk[] {
        const chunks: DocumentChunk[] = [];
        const lines = content.split('\n');
        
        let buffer = '';
        let headingHierarchy: string[] = [];
        let bufferHeadings: { level: number; text: string }[] = [];
        let chunkCounter = 0;

        const computeTopicHierarchy = (): string[] => {
            if (bufferHeadings.length === 0) return headingHierarchy;
            
            const deepestLevel = Math.max(...bufferHeadings.map(h => h.level));
            const deepestHeadings = bufferHeadings.filter(h => h.level === deepestLevel);
            
            if (deepestHeadings.length > 1 && deepestLevel > 1) {
                return headingHierarchy.slice(0, deepestLevel - 1);
            }
            
            return headingHierarchy;
        };

        const createChunk = (content: string, hierarchy: string[]): DocumentChunk => {
            const breadcrumbs = hierarchy.filter(h => h).join(' > ');
            const contextPrefix = breadcrumbs ? `[Topic: ${breadcrumbs}]\n` : '';
            const searchableText = contextPrefix + content.trim();
            const chunkId = this.generateHash(searchableText);

            return {
                chunkId,
                content: searchableText,
                section: hierarchy[hierarchy.length - 1] || 'Introduction',
                headingHierarchy: hierarchy.filter(h => h),
                chunkIndex: chunkCounter++,
                totalChunks: 0,
                url: `file://${filePath}`,
                hash: chunkId
            };
        };

        const flushBuffer = (force = false) => {
            const trimmed = buffer.trim();
            if (!trimmed) return;

            const tokenCount = this.tokenize(trimmed).length;
            
            if (tokenCount < this.minTokens && !force) return;

            const hierarchy = computeTopicHierarchy();

            if (tokenCount > this.maxTokens) {
                const tokens = this.tokenize(trimmed);
                const overlapSize = Math.floor(this.maxTokens * this.overlapPercent);
                
                for (let i = 0; i < tokens.length; i += (this.maxTokens - overlapSize)) {
                    const subTokens = tokens.slice(i, i + this.maxTokens);
                    chunks.push(createChunk(subTokens.join(''), hierarchy));
                }
            } else {
                chunks.push(createChunk(trimmed, hierarchy));
            }

            buffer = '';
            bufferHeadings = [];
        };

        for (const line of lines) {
            const isHeading = line.startsWith('#');

            if (isHeading) {
                const match = line.match(/^(#+)/);
                const level = match ? match[1].length : 1;
                const headingText = line
                    .replace(/^#+\s*/, '')
                    .replace(/\[.*?\]\(#[^)]*\)/g, '')
                    .trim();

                const currentTokens = this.tokenize(buffer.trim()).length;
                const hasContent = currentTokens > 0;
                const isSmall = currentTokens < this.minTokens;
                const deepestLevel = bufferHeadings.length > 0 
                    ? Math.max(...bufferHeadings.map(h => h.level)) 
                    : 0;
                const shouldMerge = hasContent && isSmall && bufferHeadings.length > 0 && level >= deepestLevel;

                if (!shouldMerge && hasContent) {
                    flushBuffer();
                }

                headingHierarchy = headingHierarchy.slice(0, level - 1);
                headingHierarchy[level - 1] = headingText;
                bufferHeadings.push({ level, text: headingText });
                buffer += line + '\n';
            } else {
                buffer += line + '\n';
                
                if (this.tokenize(buffer).length >= this.maxTokens) {
                    flushBuffer();
                }
            }
        }

        flushBuffer(true);

        // Update total chunks
        const total = chunks.length;
        chunks.forEach(chunk => {
            chunk.totalChunks = total;
        });

        return chunks;
    }
}
