import { Router } from 'express';
import { listActors, listChanges } from '../audit.js';
import { number } from '../validate.js';

const router = Router();

router.get('/actors', async (_req, res) => {
  res.json(await listActors());
});

// GET /api/audit/changes?before=<id>&only=deleted: a page of saves, newest first.
router.get('/changes', async (req, res) => {
  res.json(await listChanges(number(req.query.before, 'before', { integer: true, min: 1 }), { deleted: req.query.only === 'deleted' }));
});

export default router;
