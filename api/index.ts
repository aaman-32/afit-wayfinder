import { Hono } from "hono";

type Bindings = {
    IMAGES: R2Bucket,
    DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>();
app.get('api/search', async (c) => {
    const query = c.req.query('q') || '';
    const { results } = await c.env.DB.prepare('SELECT * FROM media WHERE title LIKE ?').bind(`%${query}%`).all();
    return c.json({ results });
});

app.get('api/download/:key', async (c) => {
    const key = c.req.param('key');
    const object = await c.env.IMAGES.get(key);
    if (!object) return c.json({ error: 'Image not found' }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    return new Response(object.body, { headers });
})

export default app;