import express, { Request, Response } from 'express';
import { importIdentity } from '../core/src/keystore';

const router = express.Router();

router.post('/identity', (req: Request, res: Response) => {
  const { nsec, force } = req.body;
  if (!nsec) {
    return res.status(400).send('Missing nsec field');
  }

  try {
    const publicIdentity = importIdentity(nsec, force);
    res.json(publicIdentity);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

export default router;