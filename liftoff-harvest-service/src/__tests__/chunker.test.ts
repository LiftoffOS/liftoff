import { chunkText } from '../chunker';

describe('chunkText', () => {
  it('returns empty array for empty text', () => {
    const result = chunkText('');
    expect(result).toEqual([]);
  });

  it('returns a single chunk with chunkIndex=0 for short text (< chunkSize)', () => {
    const text = 'Hello world';
    const result = chunkText(text, { chunkSize: 1600 });
    expect(result).toHaveLength(1);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[0].text).toBe(text);
  });

  it('returns a single chunk when text equals exactly chunkSize', () => {
    const text = 'a'.repeat(1600);
    const result = chunkText(text, { chunkSize: 1600 });
    expect(result).toHaveLength(1);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[0].text).toBe(text);
  });

  it('returns multiple chunks for long text with correct chunkIndex values', () => {
    // 3200 chars with chunkSize=1600, overlap=400 → step=1200
    // chunk 0: [0, 1600), chunk 1: [1200, 2800), chunk 2: [2400, 3200)
    const text = 'a'.repeat(3200);
    const result = chunkText(text, { chunkSize: 1600, overlap: 400 });
    expect(result.length).toBeGreaterThan(1);
    result.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
    });
  });

  it('adjacent chunks share overlap chars at boundaries', () => {
    // Use chunkSize well above minSize (150) so subsequent chunks are not discarded.
    const chunkSize = 400;
    const overlap = 80;
    // step = 400 - 80 = 320
    // Build 1000-char text — produces chunks at [0,400), [320,720), [640,1000)
    const text = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
    const result = chunkText(text, { chunkSize, overlap });
    expect(result.length).toBeGreaterThanOrEqual(2);
    // The end of chunk 0 should equal the start of chunk 1 for `overlap` chars
    const endOf0 = result[0].text.slice(-overlap);
    const startOf1 = result[1].text.slice(0, overlap);
    expect(endOf0).toBe(startOf1);
  });

  it('does not exceed maxChunks', () => {
    // 100 000 chars with default settings (chunkSize=1600, overlap=400, maxChunks=20)
    const text = 'x'.repeat(100_000);
    const result = chunkText(text, { maxChunks: 20 });
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('uses default maxChunks of 20', () => {
    const text = 'y'.repeat(200_000);
    const result = chunkText(text);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('discards trailing fragment below minSize (150 chars) when it is not the only chunk', () => {
    // craft text where the last chunk would be tiny
    // chunkSize=1600, overlap=400 → step=1200
    // 1600 + 1200 + 50 = 2850 chars → chunk0=[0,1600), chunk1=[1200,2800), chunk2=[2400,2850) = 450 chars >= 150 so this won't test discard
    // Instead, use chunkSize=500, overlap=100 (step=400), minSize default 150
    // text length = 500 + 400 + 50 = 950 → chunk0=[0,500), chunk1=[400,900), chunk2=[800,950)=150 chars >= 150
    // For a real discard case: chunk2=[800,849) = 49 chars → text length = 849
    const chunkSize = 500;
    const overlap = 100;
    // step = 400; chunks start at 0, 400, 800
    // chunk2 = [800, 849) = 49 chars → below minSize=150, should be discarded
    const text = 'z'.repeat(849);
    const result = chunkText(text, { chunkSize, overlap });
    // chunk0=[0,500), chunk1=[400,900) but text only 849 so [400,849)=449 chars, chunk2 would start at 800 → [800,849)=49 chars → discarded
    const lengths = result.map((c) => c.text.length);
    for (const len of lengths) {
      expect(len).toBeGreaterThanOrEqual(150);
    }
    // The last chunk text should NOT be 49 chars
    const last = result[result.length - 1];
    expect(last.text.length).toBeGreaterThanOrEqual(150);
  });

  it('single tiny chunk is kept even when below minSize (only chunk rule)', () => {
    // text length 50, chunkSize=1600 → single chunk path (text.length <= chunkSize)
    const text = 'short text here';
    const result = chunkText(text, { chunkSize: 1600 });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(text);
  });

  it('chunk count matches expected for known input dimensions', () => {
    // chunkSize=100, overlap=20 → step=80
    // text=500 chars → starts: 0,80,160,240,320,400 → 6 chunks (all >= 150? no, last few may be < 150)
    // start=0 end=100 (100 chars >= 150? no, but it's the first so kept)
    // Actually, minSize=150 but chunkSize=100 < 150... the first chunk is always kept.
    // Let's use larger chunkSize to get predictable counts.
    // chunkSize=200, overlap=50 → step=150
    // text=650 chars → starts: 0,150,300,450 → chunks: [0,200],[150,350],[300,500],[450,650]
    // all 200 chars each (last is 200) → 4 chunks
    const text = 'a'.repeat(650);
    const result = chunkText(text, { chunkSize: 200, overlap: 50 });
    expect(result).toHaveLength(4);
  });

  it('each chunk has sequential chunkIndex values starting from 0', () => {
    const text = 'b'.repeat(5000);
    const result = chunkText(text);
    result.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
    });
  });
});
