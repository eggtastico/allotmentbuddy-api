async function testOllama() {
  try {
    console.log('Testing Ollama API call...');
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral',
        prompt: 'Say hello',
        stream: false,
      }),
    });
    
    console.log('Response status:', res.status);
    const data = await res.json();
    console.log('Response:', data.response?.substring(0, 100) || 'empty');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testOllama();
