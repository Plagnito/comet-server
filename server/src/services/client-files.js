import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nonceScripts } from '../security-headers.js';

export function serveClient(app, directory) {
  if (!existsSync(directory)) return;
  const index = (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').type('html').send(nonceScripts(readFileSync(join(directory, 'index.html'), 'utf8'), res.locals.scriptNonce));
    } catch (error) { next(error); }
  };
  app.get(['/', '/index.html'], index);
  app.use(express.static(directory, { index: false }));
  app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : index(req, res, next));
}
