// Chokidar's native macOS watcher path can trip EMFILE in Vitest even when the
// watcher assertions succeed. Use polling in tests only to keep production
// watcher behavior unchanged.
process.env.CHOKIDAR_USEPOLLING ??= "1";
