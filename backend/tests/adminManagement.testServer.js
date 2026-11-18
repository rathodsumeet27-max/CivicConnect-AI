"use strict";

const express = require("express");
const mongoose = require("mongoose");
const connectDatabase = require("../src/config/database");
const adminRoutes = require("../src/routes/adminRoutes");

const expectedDatabaseName = "civicconnect_ai_admin_management_test";
const developmentDatabaseName = "civicconnect_ai";
let server;
let shuttingDown = false;

function sendStartupMessage(message) {
    if (typeof process.send === "function" && process.connected) {
        process.send(message);
    }
}

function validateConfiguration() {
    const mongoUri = process.env.CIVICCONNECT_ADMIN_TEST_MONGODB_URI;
    const portValue = process.env.CIVICCONNECT_ADMIN_TEST_PORT;

    if (!mongoUri || process.env.CIVICCONNECT_ALLOW_TEST_CLEANUP !== "YES") {
        throw new Error("Explicit admin management test configuration is required");
    }

    let databaseName;
    try {
        const parsedUri = new URL(mongoUri);
        databaseName = decodeURIComponent(parsedUri.pathname.replace(/^\/+/, ""));
        if (!["mongodb:", "mongodb+srv:"].includes(parsedUri.protocol)) {
            throw new Error();
        }
    } catch {
        throw new Error("Admin management test MongoDB URI is invalid");
    }

    if (
        databaseName !== expectedDatabaseName
        || databaseName === developmentDatabaseName
    ) {
        throw new Error("Admin management tests require the isolated test database");
    }

    if (!/^[1-9]\d*$/.test(portValue || "")) {
        throw new Error("An explicit admin management test port is required");
    }

    const port = Number(portValue);
    if (!Number.isSafeInteger(port) || port > 65535) {
        throw new Error("Admin management test port is invalid");
    }

    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim().length === 0) {
        throw new Error("Admin management test JWT secret is required");
    }

    process.env.MONGODB_URI = mongoUri;
    process.env.PORT = String(port);
    return port;
}

async function shutdown() {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    try {
        if (server && server.listening) {
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
        await mongoose.disconnect();
        process.exitCode = 0;
    } catch {
        process.exitCode = 1;
    } finally {
        if (process.connected) {
            process.disconnect();
        }
    }
}

process.once("SIGTERM", () => {
    shutdown();
});
process.once("SIGINT", () => {
    shutdown();
});

async function startServer() {
    const port = validateConfiguration();
    await connectDatabase();

    const app = express();
    app.use(express.json({ limit: "10kb" }));
    app.use("/api/admin", adminRoutes);
    app.use((error, req, res, next) => {
        if (error && error.type === "entity.parse.failed") {
            return res.status(400).json({
                success: false,
                message: "Request body must be valid JSON"
            });
        }

        if (error && error.type === "entity.too.large") {
            return res.status(413).json({
                success: false,
                message: "Request body is too large"
            });
        }

        console.error("Admin management test request failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "An unexpected error occurred"
        });
    });

    server = app.listen(port);
    server.once("listening", () => sendStartupMessage({ type: "ready" }));
    server.once("error", () => {
        sendStartupMessage({ type: "startup-error" });
        shutdown();
    });
}

startServer().catch(async () => {
    sendStartupMessage({ type: "startup-error" });
    try {
        await mongoose.disconnect();
    } finally {
        process.exitCode = 1;
        if (process.connected) {
            process.disconnect();
        }
    }
});
