import * as path from 'path';
import { ContentProcessor } from '../src/processor';

describe('ContentProcessor', () => {
  it('chunks long content and preserves hierarchy', () => {
    const processor = new ContentProcessor();
    const words = new Array(1200).fill('token').join(' ');
    const content = `# Overview\n\n${words}`;
    const filePath = path.join('/tmp', 'doc.md');

    const chunks = processor.chunkContent(content, filePath);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, index) => {
      expect(chunk.chunkIndex).toBe(index);
      expect(chunk.totalChunks).toBe(chunks.length);
      expect(chunk.headingHierarchy[0]).toBe('Overview');
      expect(chunk.url).toBe(`file://${filePath}`);
    });
  });

  it('converts html to markdown with sanitized output', () => {
    const processor = new ContentProcessor();
    const html = '<h1>Title</h1><script>alert(1)</script><p>Hello</p>';
    const markdown = processor.convertHtmlToMarkdown(html);

    expect(markdown).toContain('# Title');
    expect(markdown).toContain('Hello');
    expect(markdown).not.toContain('script');
  });
});
