async function testOllama() {
  try {
    console.log('Testing neural-chat...');
    const start = Date.now();
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'neural-chat',
        prompt: 'Say OK',
        stream: false,
      }),
    });
    
    const elapsed = Date.now() - start;
    console.log(`Response received in ${elapsed}ms`);
    const data = await res.json();
    console.log('✓ Works:', data.response?.substring(0, 50));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testOllama();
