const isProd = () => process.env.NODE_ENV === 'production';

/** Centralized error handler — every route's thrown/rejected errors land here with a consistent shape. */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // Body-parser problems are the client's fault, and deserve a clear message rather than a stack trace.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });

  // Routes signal expected failures with a plain Error (400) or an explicit err.status.
  const status = err.status || 400;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err);
  else console.warn(`[warn] ${req.method} ${req.path}: ${err.message}`);

  // Never leak internals of a genuine server fault to the public in production.
  const message = status >= 500 && isProd() ? 'Something went wrong on our side. Please try again.' : (err.message || 'Something went wrong');
  res.status(status).json({ error: message });
}

/** Wraps an async route handler so a rejected promise reaches errorHandler instead of crashing the process. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { errorHandler, asyncRoute };
