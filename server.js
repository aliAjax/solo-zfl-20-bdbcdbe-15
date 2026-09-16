const { createApp } = require("./lib/app");

const app = createApp();
const port = Number(process.env.PORT || 3020);

app.start(port).then(() => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${port}`);
});
