import { Router } from 'express';
import { clearTestData, previewTestData } from '../testdata.js';

const router = Router();

// How much test data there is, and what clearing it would keep.
router.get('/', async (_req, res) => {
  res.json(await previewTestData());
});

router.post('/clear', async (_req, res) => {
  res.json(await clearTestData());
});

export default router;
