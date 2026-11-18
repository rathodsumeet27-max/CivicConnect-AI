"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { after, before, test } = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const requireCurrentAdmin = require("../src/middleware/adminMiddleware");
const {
    getAdminUsers,
    getAdminUserById,
    updateAdminUserRole
} = require("../src/controllers/adminController");

const expectedDatabaseName = "civicconnect_ai_admin_management_test";
const developmentDatabaseName = "civicconnect_ai";
const testServerPath = path.join(__dirname, "adminManagement.testServer.js");
const safeUserKeys = ["createdAt", "email", "id", "name", "role", "updatedAt"];
const recordedUserIds = [];
let testMongoUri;
let testPort;
let testServerProcess;
let jwtSecret;
let runTag;
let fixtures;
let tokens;

function getTestConfiguration() {
    const mongoUri = process.env.CIVICCONNECT_ADMIN_TEST_MONGODB_URI;
    const portValue = process.env.CIVICCONNECT_ADMIN_TEST_PORT;

    if (!mongoUri) {
        throw new Error("CIVICCONNECT_ADMIN_TEST_MONGODB_URI is required");
    }
    if (process.env.CIVICCONNECT_ALLOW_TEST_CLEANUP !== "YES") {
        throw new Error("CIVICCONNECT_ALLOW_TEST_CLEANUP must be YES");
    }

    let databaseName;
    try {
        const parsedUri = new URL(mongoUri);
        databaseName = decodeURIComponent(parsedUri.pathname.replace(/^\/+/, ""));
        if (!["mongodb:", "mongodb+srv:"].includes(parsedUri.protocol)) {
            throw new Error();
        }
    } catch {
        throw new Error("CIVICCONNECT_ADMIN_TEST_MONGODB_URI is invalid");
    }

    if (databaseName !== expectedDatabaseName || databaseName === developmentDatabaseName) {
        throw new Error("Tests require the isolated admin management test database");
    }
    if (!/^[1-9]\d*$/.test(portValue || "")) {
        throw new Error("CIVICCONNECT_ADMIN_TEST_PORT must be explicitly configured");
    }

    const port = Number(portValue);
    if (!Number.isSafeInteger(port) || port > 65535) {
        throw new Error("CIVICCONNECT_ADMIN_TEST_PORT must be between 1 and 65535");
    }

    return { mongoUri, port };
}

function createToken(subject, role, secret = jwtSecret) {
    return jwt.sign(
        { role },
        secret,
        {
            algorithm: "HS256",
            audience: "civicconnect-ai-api",
            expiresIn: "5m",
            issuer: "civicconnect-ai",
            subject: subject.toString()
        }
    );
}

function requestUrl(pathname) {
    return `http://127.0.0.1:${testPort}${pathname}`;
}

async function request(pathname, { token, method = "GET", body, rawBody } = {}) {
    const headers = {};
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined || rawBody !== undefined) {
        headers["content-type"] = "application/json";
    }

    const response = await fetch(requestUrl(pathname), {
        method,
        headers,
        body: rawBody !== undefined
            ? rawBody
            : body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
    });
    return { response, payload: await response.json() };
}

async function createUser(label, role, nameSuffix = "", includeRunTag = true) {
    const userId = new mongoose.Types.ObjectId();
    const emailTag = includeRunTag ? `${runTag}-` : "";
    const nameTag = includeRunTag ? `${runTag} ` : "";
    const email = `${emailTag}${label}-${crypto.randomUUID()}@example.test`;
    const name = `Admin Management ${nameTag}${label}${nameSuffix}`;

    let user;
    try {
        user = await User.create({
            _id: userId,
            name,
            email,
            password: crypto.randomBytes(24).toString("hex"),
            role
        });
    } catch {
        try {
            if (await User.exists({ _id: userId, email })) {
                recordedUserIds.push(userId);
            }
        } catch {
            throw new Error("Unable to verify creation of an admin management test user");
        }
        throw new Error("Unable to create an admin management test user");
    }

    recordedUserIds.push(user._id);
    return { user, email };
}

async function waitForTestServer(child) {
    await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error("Admin management test server did not start in time"));
            }
        }, 30000);

        child.once("error", () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error("Unable to start admin management test server"));
            }
        });
        child.once("exit", () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error("Admin management test server exited before becoming ready"));
            }
        });
        child.on("message", (message) => {
            if (settled) {
                return;
            }
            if (message && message.type === "ready") {
                settled = true;
                clearTimeout(timeout);
                resolve();
            } else if (message && message.type === "startup-error") {
                settled = true;
                clearTimeout(timeout);
                reject(new Error("Admin management test server failed to start"));
            }
        });
    });
}

async function stopTestServer() {
    const child = testServerProcess;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            child.kill();
        }, 5000);
        child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
        child.kill();
    });
}

function createResponse() {
    return {
        statusCode: null,
        body: null,
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

function rejectedQuery(error) {
    return {
        select() {
            return this;
        },
        sort() {
            return this;
        },
        skip() {
            return this;
        },
        limit() {
            return this;
        },
        lean() {
            return Promise.reject(error);
        }
    };
}

function assertSafeUser(user) {
    assert.deepEqual(Object.keys(user).sort(), [...safeUserKeys].sort());
    assert.equal(Object.hasOwn(user, "password"), false);
    assert.equal(Object.hasOwn(user, "passwordHash"), false);
}

before(async () => {
    const configuration = getTestConfiguration();
    testMongoUri = configuration.mongoUri;
    testPort = configuration.port;

    try {
        await mongoose.connect(testMongoUri, { serverSelectionTimeoutMS: 10000 });
    } catch {
        throw new Error("Unable to connect to the configured admin management test database");
    }

    runTag = crypto.randomUUID();
    jwtSecret = crypto.randomBytes(32).toString("hex");

    const adminRecord = await createUser("admin", "admin");
    const staleRoleRecord = await createUser("stale-role", "worker");
    const citizenRecord = await createUser("citizen", "citizen");
    const workerRecord = await createUser("worker", "worker");
    const authorityRecord = await createUser("authority", "authority");
    const targetCitizenRecord = await createUser("target-citizen", "citizen");
    const targetAuthorityRecord = await createUser("target-authority", "authority");
    const targetWorkerRecord = await createUser("target-worker", "worker");
    const targetAdminRecord = await createUser("target-admin", "admin");
    const literalSearchRecord = await createUser(
        "literal",
        "citizen",
        " [literal].*"
    );

    fixtures = {
        admin: adminRecord.user,
        staleRole: staleRoleRecord.user,
        citizen: citizenRecord.user,
        worker: workerRecord.user,
        authority: authorityRecord.user,
        targetCitizen: targetCitizenRecord.user,
        targetAuthority: targetAuthorityRecord.user,
        targetWorker: targetWorkerRecord.user,
        targetAdmin: targetAdminRecord.user,
        literalSearch: literalSearchRecord.user,
        allUsers: [
            adminRecord.user,
            staleRoleRecord.user,
            citizenRecord.user,
            workerRecord.user,
            authorityRecord.user,
            targetCitizenRecord.user,
            targetAuthorityRecord.user,
            targetWorkerRecord.user,
            targetAdminRecord.user,
            literalSearchRecord.user
        ]
    };

    tokens = {
        admin: createToken(fixtures.admin._id, "admin"),
        staleAdmin: createToken(fixtures.staleRole._id, "admin"),
        staleCitizen: createToken(fixtures.admin._id, "citizen"),
        citizen: createToken(fixtures.citizen._id, "citizen"),
        worker: createToken(fixtures.worker._id, "worker"),
        authority: createToken(fixtures.authority._id, "authority")
    };

    const childEnvironment = { ...process.env };
    delete childEnvironment.MONGODB_URI;
    delete childEnvironment.PORT;
    testServerProcess = fork(testServerPath, [], {
        env: {
            ...childEnvironment,
            CIVICCONNECT_ADMIN_TEST_MONGODB_URI: testMongoUri,
            CIVICCONNECT_ADMIN_TEST_PORT: String(testPort),
            CIVICCONNECT_ALLOW_TEST_CLEANUP: "YES",
            JWT_SECRET: jwtSecret
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    await waitForTestServer(testServerProcess);
});

after(async () => {
    await stopTestServer();

    try {
        if (recordedUserIds.length > 0 && mongoose.connection.readyState !== 1) {
            throw new Error("Cannot clean up admin management test users without the test database");
        }
        if (recordedUserIds.length > 0) {
            const cleanupResult = await User.deleteMany({
                _id: { $in: recordedUserIds }
            });
            if (cleanupResult.deletedCount !== recordedUserIds.length) {
                throw new Error("Unable to remove all recorded admin management test users");
            }
        }
    } finally {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    }
});

test("admin routes require authentication and the current database admin role", async () => {
    const requests = [
        { pathname: "/api/admin/users", method: "GET" },
        {
            pathname: `/api/admin/users/${fixtures.targetCitizen._id}`,
            method: "GET"
        },
        {
            pathname: `/api/admin/users/${fixtures.targetCitizen._id}/role`,
            method: "PATCH",
            body: { role: "worker" }
        }
    ];

    for (const route of requests) {
        const unauthenticated = await request(route.pathname, {
            method: route.method,
            body: route.body
        });
        assert.equal(unauthenticated.response.status, 401);

        for (const token of [tokens.citizen, tokens.worker, tokens.authority]) {
            const denied = await request(route.pathname, {
                token,
                method: route.method,
                body: route.body
            });
            assert.equal(denied.response.status, 403);
        }
    }
});

test("admin routes reject stale admin JWT roles using the current database role", async () => {
    const routes = [
        { pathname: "/api/admin/users", method: "GET" },
        {
            pathname: `/api/admin/users/${fixtures.targetCitizen._id}`,
            method: "GET"
        },
        {
            pathname: `/api/admin/users/${fixtures.targetCitizen._id}/role`,
            method: "PATCH",
            body: { role: "worker" }
        }
    ];

    for (const route of routes) {
        const result = await request(route.pathname, {
            token: tokens.staleAdmin,
            method: route.method,
            body: route.body
        });
        assert.equal(result.response.status, 403);
    }

    const stillUnchanged = await User.findById(fixtures.targetCitizen._id).select("role");
    assert.equal(stillUnchanged.role, "citizen");

    const currentAdminWithStaleLowerClaim = await request("/api/admin/users", {
        token: tokens.staleCitizen
    });
    assert.equal(currentAdminWithStaleLowerClaim.response.status, 200);
});

test("admin authorization follows database role transitions after JWT issuance", async () => {
    const demotedRecord = await createUser("post-token-demotion", "admin", "", false);
    const demotedToken = createToken(demotedRecord.user._id, "admin");
    const demotionUpdate = await User.updateOne(
        { _id: demotedRecord.user._id, role: "admin" },
        { $set: { role: "worker" } }
    );
    assert.equal(demotionUpdate.matchedCount, 1);

    const demotionRequests = await Promise.all([
        request("/api/admin/users", { token: demotedToken }),
        request(`/api/admin/users/${fixtures.targetCitizen._id}`, {
            token: demotedToken
        }),
        request(`/api/admin/users/${fixtures.targetCitizen._id}/role`, {
            token: demotedToken,
            method: "PATCH",
            body: { role: "worker" }
        })
    ]);
    assert.deepEqual(
        demotionRequests.map(({ response }) => response.status),
        [403, 403, 403]
    );
    const [demotedUser, unchangedTarget] = await Promise.all([
        User.findById(demotedRecord.user._id).select("role"),
        User.findById(fixtures.targetCitizen._id).select("role")
    ]);
    assert.equal(demotedUser.role, "worker");
    assert.equal(unchangedTarget.role, "citizen");

    const promotedRecord = await createUser("post-token-promotion", "citizen", "", false);
    const promotionToken = createToken(promotedRecord.user._id, "citizen");
    const promotionUpdate = await User.updateOne(
        { _id: promotedRecord.user._id, role: "citizen" },
        { $set: { role: "admin" } }
    );
    assert.equal(promotionUpdate.matchedCount, 1);

    const promotionTarget = await createUser("post-token-promotion-target", "worker", "", false);
    const promotionRequests = await Promise.all([
        request("/api/admin/users", { token: promotionToken }),
        request(`/api/admin/users/${promotionTarget.user._id}`, {
            token: promotionToken
        }),
        request(`/api/admin/users/${promotionTarget.user._id}/role`, {
            token: promotionToken,
            method: "PATCH",
            body: { role: "authority" }
        })
    ]);
    assert.deepEqual(
        promotionRequests.map(({ response }) => response.status),
        [200, 200, 200]
    );
    assertSafeUser(promotionRequests[1].payload.data.user);
    assert.equal(promotionRequests[2].payload.data.user.role, "authority");

    const [promotedUser, updatedTarget] = await Promise.all([
        User.findById(promotedRecord.user._id).select("role"),
        User.findById(promotionTarget.user._id).select("role")
    ]);
    assert.equal(promotedUser.role, "admin");
    assert.equal(updatedTarget.role, "authority");
});

test("admin user listing supports bounded pagination, role filters, and literal search", async () => {
    const search = encodeURIComponent(runTag);
    const pageResult = await request(
        `/api/admin/users?search=${encodeURIComponent(runTag.toUpperCase())}&page=2&limit=3`,
        { token: tokens.admin }
    );

    assert.equal(pageResult.response.status, 200);
    assert.deepEqual(Object.keys(pageResult.payload.data).sort(), [
        "pagination",
        "users"
    ]);
    assert.deepEqual(pageResult.payload.data.pagination, {
        currentPage: 2,
        totalPages: 4,
        totalUsers: fixtures.allUsers.length,
        limit: 3
    });
    assert.equal(pageResult.payload.data.users.length, 3);
    for (const user of pageResult.payload.data.users) {
        assertSafeUser(user);
    }

    const roleResult = await request(
        `/api/admin/users?search=${search}&role=worker`,
        { token: tokens.admin }
    );
    assert.equal(roleResult.response.status, 200);
    assert.equal(roleResult.payload.data.pagination.totalUsers, 3);
    assert.ok(roleResult.payload.data.users.every((user) => user.role === "worker"));

    const emailSearch = encodeURIComponent(
        fixtures.targetAuthority.email.split("@")[0].toUpperCase()
    );
    const emailResult = await request(
        `/api/admin/users?search=${emailSearch}`,
        { token: tokens.admin }
    );
    assert.equal(emailResult.response.status, 200);
    assert.deepEqual(
        emailResult.payload.data.users.map((user) => user.id),
        [fixtures.targetAuthority._id.toString()]
    );

    const literalSearch = encodeURIComponent("[literal].*");
    const literalResult = await request(
        `/api/admin/users?search=${literalSearch}`,
        { token: tokens.admin }
    );
    assert.equal(literalResult.response.status, 200);
    assert.deepEqual(
        literalResult.payload.data.users.map((user) => user.id),
        [fixtures.literalSearch._id.toString()]
    );
});

test("admin user listing rejects invalid and unbounded query values", async () => {
    const invalidQueries = [
        "?unknown=x",
        "?role=superadmin",
        "?page=0",
        "?page=1.5",
        "?page=100002&limit=1",
        "?limit=101",
        "?limit=1&limit=2",
        "?search=",
        `?search=${"x".repeat(101)}`
    ];

    for (const query of invalidQueries) {
        const result = await request(`/api/admin/users${query}`, {
            token: tokens.admin
        });
        assert.equal(result.response.status, 400, query);
    }
});

test("admin user detail validates IDs and returns only safe user fields", async () => {
    const malformed = await request("/api/admin/users/not-an-object-id", {
        token: tokens.admin
    });
    const missing = await request(
        `/api/admin/users/${new mongoose.Types.ObjectId()}`,
        { token: tokens.admin }
    );
    const found = await request(
        `/api/admin/users/${fixtures.targetCitizen._id}`,
        { token: tokens.admin }
    );

    assert.equal(malformed.response.status, 400);
    assert.equal(missing.response.status, 404);
    assert.equal(found.response.status, 200);
    assertSafeUser(found.payload.data.user);
    assert.equal(found.payload.data.user.id, fixtures.targetCitizen._id.toString());
    assert.equal(found.payload.data.user.role, "citizen");
});

test("admin role updates accept only citizen, authority, and worker", async () => {
    const updates = [
        ["targetCitizen", "authority"],
        ["targetAuthority", "worker"],
        ["targetWorker", "citizen"]
    ];

    for (const [fixtureName, role] of updates) {
        const target = fixtures[fixtureName];
        const result = await request(`/api/admin/users/${target._id}/role`, {
            token: tokens.admin,
            method: "PATCH",
            body: { role }
        });

        assert.equal(result.response.status, 200);
        assertSafeUser(result.payload.data.user);
        assert.equal(result.payload.data.user.id, target._id.toString());
        assert.equal(result.payload.data.user.role, role);

        const savedUser = await User.findById(target._id).select("role");
        assert.equal(savedUser.role, role);
    }
});

test("admin role updates reject invalid bodies and admin promotion", async () => {
    const target = fixtures.citizen;
    const pathname = `/api/admin/users/${target._id}/role`;
    const invalidBodies = [
        undefined,
        null,
        [],
        {},
        { role: "admin" },
        { role: "superadmin" },
        { role: 12 },
        { role: "worker", email: "attacker@example.test" },
        { role: "worker", password: "unexpected" }
    ];

    for (const body of invalidBodies) {
        const result = await request(pathname, {
            token: tokens.admin,
            method: "PATCH",
            body
        });
        assert.equal(result.response.status, 400);
    }

    const savedUser = await User.findById(target._id).select("role");
    assert.equal(savedUser.role, "citizen");
});

test("admins cannot change their own role or demote an existing admin", async () => {
    const selfChange = await request(
        `/api/admin/users/${fixtures.admin._id}/role`,
        {
            token: tokens.admin,
            method: "PATCH",
            body: { role: "worker" }
        }
    );
    assert.equal(selfChange.response.status, 403);

    const demotionAttempts = await Promise.all([
        request(`/api/admin/users/${fixtures.targetAdmin._id}/role`, {
            token: tokens.admin,
            method: "PATCH",
            body: { role: "citizen" }
        }),
        request(`/api/admin/users/${fixtures.targetAdmin._id}/role`, {
            token: tokens.admin,
            method: "PATCH",
            body: { role: "worker" }
        })
    ]);
    assert.deepEqual(
        demotionAttempts.map(({ response }) => response.status),
        [409, 409]
    );

    const [savedAdmin, savedActor] = await Promise.all([
        User.findById(fixtures.targetAdmin._id).select("role"),
        User.findById(fixtures.admin._id).select("role")
    ]);
    assert.equal(savedAdmin.role, "admin");
    assert.equal(savedActor.role, "admin");
});

test("admin role update validates IDs and missing users", async () => {
    const malformed = await request("/api/admin/users/invalid/role", {
        token: tokens.admin,
        method: "PATCH",
        body: { role: "worker" }
    });
    const missing = await request(
        `/api/admin/users/${new mongoose.Types.ObjectId()}/role`,
        {
            token: tokens.admin,
            method: "PATCH",
            body: { role: "worker" }
        }
    );

    assert.equal(malformed.response.status, 400);
    assert.equal(missing.response.status, 404);
});

test("admin authorization middleware reports database failures generically", async () => {
    const originalFindById = User.findById;
    User.findById = () => rejectedQuery(new Error("Synthetic admin lookup failure"));

    try {
        const response = createResponse();
        await requireCurrentAdmin(
            { user: { id: new mongoose.Types.ObjectId().toString() } },
            response,
            () => assert.fail("next must not be called after a database failure")
        );

        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, {
            success: false,
            message: "Unable to verify administrator access at this time"
        });
    } finally {
        User.findById = originalFindById;
    }
});

test("admin controllers report database failures generically", async () => {
    const originalFind = User.find;
    const originalCountDocuments = User.countDocuments;
    const originalFindById = User.findById;
    const originalFindOneAndUpdate = User.findOneAndUpdate;

    try {
        User.find = () => {
            throw new Error("Synthetic list failure");
        };
        User.countDocuments = () => Promise.resolve(0);
        const listResponse = createResponse();
        await getAdminUsers({ query: {} }, listResponse);
        assert.equal(listResponse.statusCode, 500);
        assert.deepEqual(listResponse.body, {
            success: false,
            message: "Unable to fetch users at this time"
        });

        User.findById = () => rejectedQuery(new Error("Synthetic detail failure"));
        const detailResponse = createResponse();
        await getAdminUserById(
            { params: { id: new mongoose.Types.ObjectId().toString() } },
            detailResponse
        );
        assert.equal(detailResponse.statusCode, 500);
        assert.deepEqual(detailResponse.body, {
            success: false,
            message: "Unable to fetch user at this time"
        });

        User.findOneAndUpdate = () => rejectedQuery(new Error("Synthetic role update failure"));
        const updateResponse = createResponse();
        await updateAdminUserRole(
            {
                user: { id: new mongoose.Types.ObjectId().toString() },
                params: { id: new mongoose.Types.ObjectId().toString() },
                body: { role: "worker" }
            },
            updateResponse
        );
        assert.equal(updateResponse.statusCode, 500);
        assert.deepEqual(updateResponse.body, {
            success: false,
            message: "Unable to update user role at this time"
        });
    } finally {
        User.find = originalFind;
        User.countDocuments = originalCountDocuments;
        User.findById = originalFindById;
        User.findOneAndUpdate = originalFindOneAndUpdate;
    }
});
