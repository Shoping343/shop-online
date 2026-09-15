FAMILY SHOP — Render + PostgreSQL

1. Upload these files to a GitHub repository:
   - index.html
   - server.js
   - package.json

2. On Render create Postgres first:
   New -> Postgres
   Name: family-shop-db
   Region: same as web service (Oregon is OK)
   Plan: Free (for testing)

3. Create Web Service from the GitHub repository:
   Language: Node
   Branch: main
   Root Directory: blank
   Build Command: npm install
   Start Command: npm start
   Plan: Free

4. Add environment variables to the Web Service:
   ADMIN_PASSWORD = your admin password
   SESSION_SECRET = any long random string
   DATABASE_URL = select the Internal Database URL from the Render Postgres service

5. Deploy.

The existing index.html already calls /api.php?action=...; server.js provides that endpoint.
Products are stored in PostgreSQL and are shared between visitors. Admin can add and delete individual custom products.
