import app from "./app.js";
import { logger } from "./observability/logger.js";

const port = process.env.PORT || 3000;

app.listen(port, () => {
  logger.info("http_server_started", { port });
});
