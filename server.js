
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DB_FILE = path.join(__dirname, "items_database.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = "3mb";
const CATEGORIES = [
  "Electronics", "Documents", "Accessories", "Clothing",
  "Bags", "Books", "Keys", "Other"
];
const URGENCIES = ["Low", "Medium", "High"];
const TYPES = ["LOST", "FOUND"];
const STATUSES = ["ACTIVE", "RESOLVED"];

if (!ADMIN_KEY || ADMIN_KEY.length < 24) {
  console.error("Set ADMIN_KEY to a secret of at least 24 characters in .env");
  process.exit(1);
}

if (!fs.existsSync(PUBLIC_DIR)) {
  console.error("Missing public directory.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(helmet({
  // Inline styles/scripts are used by the standalone frontend.
  // A production deployment should move these into separate files.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));
app.use(express.static(PUBLIC_DIR, {
  index: "index.html",
  dotfiles: "deny"
}));

// Initialize the JSON database if necessary.
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]\n", { flag: "wx" });
}

let writeQueue = Promise.resolve();

function readItems() {
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data)) {
    throw new Error("Database must contain a JSON array.");
  }

  return data;
}

// Serialize writes to prevent overlapping requests from overwriting each
// other's changes within this single Node.js process.
function saveItems(items) {
  const operation = writeQueue.then(async () => {
    const tempFile = `${DB_FILE}.${crypto.randomUUID()}.tmp`;

    try {
      await fs.promises.writeFile(
        tempFile,
        JSON.stringify(items, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" }
      );
      await fs.promises.rename(tempFile, DB_FILE);
    } catch (error) {
      await fs.promises.rm(tempFile, { force: true }).catch(() => {});
      throw error;
    }
  });

  writeQueue = operation.catch(() => {});
  return operation;
}

function apiError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function cleanString(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function validDate(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function parseImage(dataUrl) {
  if (dataUrl == null || dataUrl === "") return null;

  if (typeof dataUrl !== "string") {
    throw new Error("Image must be a Base64 data URL.");
  }

  const match = dataUrl.match(
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/
  );

  if (!match || !match[2]) {
    throw new Error("Only valid PNG, JPG, or WEBP images are accepted.");
  }

  const bytes = Buffer.from(match[2], "base64");

  // Buffer.from() is permissive, so require canonical Base64.
  if (bytes.toString("base64") !== match[2]) {
    throw new Error("Invalid Base64 image encoding.");
  }

  if (bytes.length === 0 || bytes.length >= MAX_IMAGE_BYTES) {
    throw new Error("Image must be smaller than 2 MB.");
  }

  // Check the actual file signature, not only the declared MIME type.
  const isPng = bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );

  const isJpeg = bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

  const isWebp = bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";

  const actualFormat = isPng ? "png" : isJpeg ? "jpeg" :
    isWebp ? "webp" : null;

  if (actualFormat !== match[1]) {
    throw new Error("Image contents do not match the declared format.");
  }

  return {
    dataUrl,
    bytes: bytes.length,
    mimeType: `image/${actualFormat}`
  };
}

function validateItem(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  const fields = [
    "title", "description", "category", "location", "date",
    "contact", "urgency", "type"
  ];

  if (partial && Object.keys(body).some(
    key => ![...fields, "image"].includes(key)
  )) {
    throw new Error("Request contains unsupported fields.");
  }

  if (partial && Object.keys(body).length === 0) {
    throw new Error("No fields were provided.");
  }

  const item = {};

  for (const field of fields) {
    if (partial && !(field in body)) continue;

    const limits = {
      title: 100,
      description: 1200,
      category: 40,
      location: 160,
      contact: 160,
      urgency: 10,
      type: 5
    };

    const value = cleanString(body[field], limits[field] || 200);

    if (!value) throw new Error(`${field} is required.`);

    item[field] = value;
  }

  if ("date" in item || (!partial && "date" in body)) {
    const date = body.date;

    if (!validDate(date)) {
      throw new Error("Date must be a valid YYYY-MM-DD date.");
    }

    item.date = date;
  }

  if ("category" in item && !CATEGORIES.includes(item.category)) {
    throw new Error("Choose a valid category.");
  }

  if ("urgency" in item && !URGENCIES.includes(item.urgency)) {
    throw new Error("Choose a valid urgency level.");
  }

  if ("type" in item && !TYPES.includes(item.type)) {
    throw new Error("Type must be LOST or FOUND.");
  }

  if ("image" in body) {
    item.image = parseImage(body.image);
  } else if (!partial) {
    item.image = null;
  }

  return item;
}

function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 2)
  );
}

function similarity(a, b) {
  const left = tokenize(`${a.title} ${a.description}`);
  const right = tokenize(`${b.title} ${b.description}`);

  const union = new Set([...left, ...right]);
  const intersection = [...left].filter(word => right.has(word));

  const keywordScore = union.size
    ? intersection.length / union.size
    : 0;

  const categoryScore = a.category === b.category ? 0.35 : 0;
  const locationScore = a.location.toLowerCase() ===
    b.location.toLowerCase() ? 0.15 : 0;

  // A shared category/location helps ranking but cannot alone establish
  // that two reports describe the same physical item.
  return Math.min(
    100,
    Math.round((keywordScore * 0.65 + categoryScore + locationScore) * 100)
  );
}

function findMatches(item, items) {
  return items
    .filter(other =>
      other.id !== item.id &&
      other.status === "ACTIVE" &&
      other.type !== item.type
    )
    .map(other => ({
      item: other,
      score: similarity(item, other)
    }))
    .filter(match => match.score >= 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(match => ({
      id: match.item.id,
      title: match.item.title,
      type: match.item.type,
      category: match.item.category,
      location: match.item.location,
      date: match.item.date,
      score: match.score
    }));
}

function publicItem(item) {
  const { image, ...rest } = item;
  return {
    ...rest,
    hasImage: Boolean(image),
    image: image?.dataUrl || null
  };
}

function requireAdmin(req, res, next) {
  const supplied = req.get("x-admin-key");

  if (!supplied || supplied.length > 256 ||
      supplied.length !== ADMIN_KEY.length ||
      !crypto.timingSafeEqual(
        Buffer.from(supplied),
        Buffer.from(ADMIN_KEY)
      )) {
    return apiError(res, 401, "Invalid administrator key.");
  }

  next();
}

// Health endpoint.
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    service: "CampusFind API",
    timestamp: new Date().toISOString()
  });
});

// Dashboard summary.
app.get("/api/stats", async (req, res, next) => {
  try {
    const items = readItems();

    res.json({
      success: true,
      total: items.length,
      lost: items.filter(i => i.type === "LOST" &&
        i.status === "ACTIVE").length,
      found: items.filter(i => i.type === "FOUND" &&
        i.status === "ACTIVE").length,
      resolved: items.filter(i => i.status === "RESOLVED").length
    });
  } catch (error) {
    next(error);
  }
});

// List active reports. Resolved records remain counted but are not shown
// in the public active-report feed.
app.get("/api/items", async (req, res, next) => {
  try {
    const items = readItems();
    const type = cleanString(req.query.type, 5).toUpperCase();
    const query = cleanString(req.query.q, 100).toLowerCase();

    if (type && ![...TYPES, "ALL"].includes(type)) {
      return apiError(res, 400, "Invalid type filter.");
    }

    let result = items.filter(item => item.status === "ACTIVE");

    if (type && type !== "ALL") {
      result = result.filter(item => item.type === type);
    }

    if (query) {
      result = result.filter(item =>
        [item.title, item.description, item.category, item.location]
          .some(value => value.toLowerCase().includes(query))
      );
    }

    result.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );

    res.json({
      success: true,
      items: result.map(publicItem)
    });
  } catch (error) {
    next(error);
  }
});

// Create a lost/found report.
app.post("/api/items", async (req, res, next) => {
  try {
    const data = validateItem(req.body);

    const item = {
      id: crypto.randomUUID(),
      ...data,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const items = readItems();
    items.push(item);
    await saveItems(items);

    res.status(201).json({
      success: true,
      message: "Report submitted successfully.",
      item: publicItem(item),
      matches: findMatches(item, items)
    });
  } catch (error) {
    if (error.message && !error.status) {
      return apiError(res, 400, error.message);
    }
    next(error);
  }
});

// Ranked matches for a particular report.
app.get("/api/items/:id/matches", async (req, res, next) => {
  try {
    const items = readItems();
    const item = items.find(i => i.id === req.params.id);

    if (!item) return apiError(res, 404, "Report not found.");

    res.json({
      success: true,
      matches: findMatches(item, items)
    });
  } catch (error) {
    next(error);
  }
});

// Resolve a report. Requires administrator authorization.
app.patch("/api/items/:id/resolve", requireAdmin, async (req, res, next) => {
  try {
    const items = readItems();
    const index = items.findIndex(i => i.id === req.params.id);

    if (index === -1) {
      return apiError(res, 404, "Report not found.");
    }

    if (items[index].status === "RESOLVED") {
      return res.json({
        success: true,
        item: publicItem(items[index]),
        message: "Report was already resolved."
      });
    }

    items[index].status = "RESOLVED";
    items[index].updatedAt = new Date().toISOString();

    await saveItems(items);

    res.json({
      success: true,
      message: "Report marked as resolved.",
      item: publicItem(items[index])
    });
  } catch (error) {
    next(error);
  }
});

// Delete a report. Requires administrator authorization.
app.delete("/api/items/:id", requireAdmin, async (req, res, next) => {
  try {
    const items = readItems();
    const index = items.findIndex(i => i.id === req.params.id);

    if (index === -1) {
      return apiError(res, 404, "Report not found.");
    }

    items.splice(index, 1);
    await saveItems(items);

    res.json({
      success: true,
      message: "Report deleted successfully."
    });
  } catch (error) {
    next(error);
  }
});

// Malformed JSON, oversized request bodies, and unexpected errors.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === "entity.too.large") {
    return apiError(res, 413, "Request body is too large.");
  }

  if (err instanceof SyntaxError && "body" in err) {
    return apiError(res, 400, "Invalid JSON request body.");
  }

  console.error(err);
  return apiError(res, 500, "Internal server error.");
});

app.listen(PORT, () => {
  console.log(`CampusFind running at http://localhost:${PORT}`);
});
