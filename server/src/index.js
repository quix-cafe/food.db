import { createApp } from './app.js';
import { migrate } from './migrate.js';

const port = Number(process.env.PORT ?? 3000);

await migrate();
createApp().listen(port, () => console.log(`food.db listening on http://localhost:${port}`));
