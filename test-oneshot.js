// Quick test: send a WAV file to the one-shot /transcribe endpoint
import fs from 'fs';

const WAV_PATH = process.env.WAV_PATH || process.argv[2] || './test-audio.wav';
const SERVICE_URL = process.env.SERVICE_URL || `http://localhost:${process.env.PORT || 10016}`;
const LANGUAGE = process.env.LANGUAGE || 'en';

async function main() {
  console.log('Reading WAV file...');
  const audioBuffer = fs.readFileSync(WAV_PATH);
  console.log(`Audio: ${audioBuffer.length} bytes`);

  console.log(`\nPOST ${SERVICE_URL}/transcribe?language=${LANGUAGE}`);
  const start = Date.now();

  const response = await fetch(`${SERVICE_URL}/transcribe?language=${LANGUAGE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: audioBuffer,
  });

  const elapsed = Date.now() - start;
  const data = await response.json();

  console.log(`\nStatus: ${response.status} (${elapsed}ms)`);
  console.log('Response:', JSON.stringify(data, null, 2));
}

main().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
