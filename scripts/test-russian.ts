// Compatibility entry point for the original developer check.
process.argv.push('--locale', 'ru');
await import('./test-speech');
export {};
