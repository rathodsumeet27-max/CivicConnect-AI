"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { after, before, test } = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Complaint = require("../src/models/Complaint");
const User = require("../src/models/User");

const expectedDatabaseName = "civicconnect_ai_worker_workflow_test";
const developmentDatabaseName = "civicconnect_ai";
const testServerPath = path.join(__dirname, "workerWorkflow.testServer.js");
const safeComplaintFields = [
    "id",
    "title",
    "description",
    "category",
    "location",
    "images",
    "status",
    "createdAt",
    "updatedAt"
];

const recordedUserIds = [];
const recordedComplaintIds = [];
let testMongoUri;
let testPort;
let testServerProcess;
let workerAId;
let workerBId;
let verificationWorkerId;
let citizenId;
let otherCitizenId;
let authorityId;
let adminId;
let fixtures;
let tokens;

function getTestConfiguration() {
    const mongoUri = process.env.CIVICCONNECT_TEST_MONGODB_URI;
    const portValue = process.env.CIVICCONNECT_TEST_PORT;

    if (!mongoUri) {
        throw new Error("CIVICCONNECT_TEST_MONGODB_URI is required");
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
        throw new Error("CIVICCONNECT_TEST_MONGODB_URI is invalid");
    }

    if (databaseName !== expectedDatabaseName || databaseName === developmentDatabaseName) {
        throw new Error("Tests require the isolated worker workflow test database");
    }
    if (!/^[1-9]\d*$/.test(portValue || "")) {
        throw new Error("CIVICCONNECT_TEST_PORT must be explicitly configured");
    }

    const port = Number(portValue);
    if (!Number.isSafeInteger(port) || port > 65535) {
        throw new Error("CIVICCONNECT_TEST_PORT must be between 1 and 65535");
    }

    return { mongoUri, port };
}

function createToken(subject, role, secret) {
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

async function waitForTestServer(child) {
    await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error("Worker workflow test server did not start in time"));
            }
        }, 30000);

        child.once("error", () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error("Unable to start worker workflow test server"));
            }
        });
        child.once("exit", () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error("Worker workflow test server exited before becoming ready"));
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
                reject(new Error("Worker workflow test server failed to start"));
            }
        });
    });
}

async function createUser(name, role, emailTag) {
    const userId = new mongoose.Types.ObjectId();
    const email = `${emailTag}-${crypto.randomUUID()}@example.test`;

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
            throw new Error("Unable to verify creation of a temporary worker workflow test user");
        }
        throw new Error("Unable to create a temporary worker workflow test user");
    }
    recordedUserIds.push(user._id);
    return user;
}

async function createComplaint(title, assignedWorkerId, status, originalComplainantId = workerAId) {
    const complaintId = new mongoose.Types.ObjectId();
    const description = `Integration test report for ${title.toLowerCase()} (${crypto.randomUUID()}).`;

    let complaint;
    try {
        complaint = await Complaint.create({
            _id: complaintId,
            title,
            description,
            category: "Road Damage",
            location: {
                address: "Test-only location",
                latitude: 0,
                longitude: 0
            },
            status,
            originalComplainantId,
            assignedWorkerId
        });
    } catch {
        try {
            if (await Complaint.exists({
                _id: complaintId,
                title,
                description,
                category: "Road Damage",
                status,
                originalComplainantId
            })) {
                recordedComplaintIds.push(complaintId);
            }
        } catch {
            throw new Error("Unable to verify creation of a temporary worker workflow test complaint");
        }
        throw new Error("Unable to create a temporary worker workflow test complaint");
    }
    recordedComplaintIds.push(complaint._id);
    return complaint;
}

async function createAuthorityReviewComplaint(
    title,
    { status = "Evidence Verification Pending", assignedWorkerId, reviewHistory = [] } = {}
) {
    const complaint = await createComplaint(
        title,
        assignedWorkerId,
        status,
        citizenId
    );
    const updateResult = await Complaint.updateOne(
        { _id: complaint._id },
        {
            $set: {
                citizenVerification: {
                    response: "resolved",
                    notes: "Integration test citizen verification",
                    evidenceImages: ["https://example.test/citizen-verification.jpg"],
                    submittedAt: new Date("2026-01-01T00:00:00.000Z"),
                    submittedBy: citizenId
                },
                authorityVerificationReviews: reviewHistory
            }
        }
    );

    if (updateResult.matchedCount !== 1) {
        throw new Error("Unable to seed a temporary authority review complaint");
    }

    return complaint;
}

function workerWorkflowUrl(pathname) {
    return `http://127.0.0.1:${testPort}${pathname}`;
}

async function request(pathname, { token, method = "GET", body, rawBody } = {}) {
    const headers = {};
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    if (rawBody !== undefined) {
        headers["content-type"] = "application/json";
    } else if (body !== undefined) {
        headers["content-type"] = "application/json";
    }

    const response = await fetch(workerWorkflowUrl(pathname), {
        method,
        headers,
        body: rawBody !== undefined
            ? rawBody
            : body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
    });
    return { response, payload: await response.json() };
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

before(async () => {
    const configuration = getTestConfiguration();
    testMongoUri = configuration.mongoUri;
    testPort = configuration.port;

    try {
        await mongoose.connect(testMongoUri, { serverSelectionTimeoutMS: 10000 });
    } catch {
        throw new Error("Unable to connect to the configured worker workflow test database");
    }

    const workerA = await createUser("Workflow Worker A", "worker", "worker-a");
    const workerB = await createUser("Workflow Worker B", "worker", "worker-b");
    const verificationWorker = await createUser(
        "Citizen Verification Worker",
        "worker",
        "citizen-verification-worker"
    );
    const citizen = await createUser("Workflow Citizen", "citizen", "citizen");
    const otherCitizen = await createUser("Workflow Other Citizen", "citizen", "other-citizen");
    const authority = await createUser("Workflow Authority", "authority", "authority");
    const admin = await createUser("Workflow Admin", "admin", "admin");
    workerAId = workerA._id;
    workerBId = workerB._id;
    verificationWorkerId = verificationWorker._id;
    citizenId = citizen._id;
    otherCitizenId = otherCitizen._id;
    authorityId = authority._id;
    adminId = admin._id;

    const workerAComplaints = {};
    workerAComplaints.assignedForStart = await createComplaint(
        "Worker A assigned start",
        workerAId,
        "Assigned"
    );
    workerAComplaints.inProgressForClaim = await createComplaint(
        "Worker A in progress claim",
        workerAId,
        "In Progress"
    );
    workerAComplaints.inProgressForInvalidStart = await createComplaint(
        "Worker A invalid start",
        workerAId,
        "In Progress"
    );
    workerAComplaints.assignedForInvalidClaim = await createComplaint(
        "Worker A invalid claim",
        workerAId,
        "Assigned"
    );
    workerAComplaints.paginationOne = await createComplaint(
        "Worker A pagination one",
        workerAId,
        "Assigned"
    );

    const workerBComplaints = {};
    workerBComplaints.assigned = await createComplaint(
        "Worker B assigned",
        workerBId,
        "Assigned"
    );
    workerBComplaints.inProgress = await createComplaint(
        "Worker B in progress",
        workerBId,
        "In Progress"
    );
    workerBComplaints.authorityDetail = await createComplaint(
        "Authority detail assigned",
        workerBId,
        "Assigned",
        citizenId
    );

    const workerProgressEvidenceComplaints = {};
    workerProgressEvidenceComplaints.success = await createComplaint(
        "Worker progress evidence success",
        verificationWorkerId,
        "In Progress",
        citizenId
    );
    workerProgressEvidenceComplaints.wrongWorker = await createComplaint(
        "Worker progress evidence wrong worker",
        verificationWorkerId,
        "In Progress",
        citizenId
    );
    workerProgressEvidenceComplaints.assigned = await createComplaint(
        "Worker progress evidence assigned",
        verificationWorkerId,
        "Assigned",
        citizenId
    );
    workerProgressEvidenceComplaints.completed = await createComplaint(
        "Worker progress evidence completed",
        verificationWorkerId,
        "Work Claimed Completed",
        citizenId
    );
    workerProgressEvidenceComplaints.invalidInput = await createComplaint(
        "Worker progress evidence invalid input",
        verificationWorkerId,
        "In Progress",
        citizenId
    );
    workerProgressEvidenceComplaints.concurrent = await createComplaint(
        "Worker progress evidence concurrent",
        verificationWorkerId,
        "In Progress",
        citizenId
    );

    const authorityComplaintFixtures = {
        assigned: workerBComplaints.authorityDetail
    };
    authorityComplaintFixtures.unassigned = await createComplaint(
        "Authority detail unassigned",
        undefined,
        "Submitted",
        citizenId
    );
    authorityComplaintFixtures.missingReferences = await createComplaint(
        "Authority detail missing references",
        new mongoose.Types.ObjectId(),
        "Submitted",
        new mongoose.Types.ObjectId()
    );

    const citizenVerificationComplaints = {};
    citizenVerificationComplaints.success = await createComplaint(
        "Citizen verification success",
        undefined,
        "Evidence Verification Pending",
        citizenId
    );
    citizenVerificationComplaints.assignedWorker = await createComplaint(
        "Citizen verification assigned worker",
        verificationWorker._id,
        "Evidence Verification Pending",
        citizenId
    );
    citizenVerificationComplaints.duplicate = await createComplaint(
        "Citizen verification duplicate",
        undefined,
        "Evidence Verification Pending",
        citizenId
    );
    citizenVerificationComplaints.concurrent = await createComplaint(
        "Citizen verification concurrent",
        undefined,
        "Evidence Verification Pending",
        citizenId
    );
    citizenVerificationComplaints.invalidInput = await createComplaint(
        "Citizen verification invalid input",
        undefined,
        "Evidence Verification Pending",
        citizenId
    );
    citizenVerificationComplaints.wrongStatus = await createComplaint(
        "Citizen verification wrong status",
        undefined,
        "Work Claimed Completed",
        citizenId
    );

    const authorityVerificationReviewComplaints = {};
    authorityVerificationReviewComplaints.authorization = await createAuthorityReviewComplaint(
        "Authority review authorization",
        { assignedWorkerId: verificationWorker._id }
    );
    authorityVerificationReviewComplaints.invalidInput = await createAuthorityReviewComplaint(
        "Authority review invalid input",
        { assignedWorkerId: verificationWorker._id }
    );
    authorityVerificationReviewComplaints.wrongStatus = await createAuthorityReviewComplaint(
        "Authority review wrong status",
        {
            status: "Work Claimed Completed",
            assignedWorkerId: verificationWorker._id
        }
    );
    authorityVerificationReviewComplaints.missingCitizenVerification = await createComplaint(
        "Authority review missing citizen verification",
        verificationWorker._id,
        "Evidence Verification Pending",
        citizenId
    );
    authorityVerificationReviewComplaints.history = await createAuthorityReviewComplaint(
        "Authority review history",
        {
            assignedWorkerId: verificationWorker._id,
            reviewHistory: [{
                decision: "Reopened",
                reviewedBy: authority._id,
                reviewedAt: new Date("2026-01-02T00:00:00.000Z"),
                reason: "Prior review entry"
            }]
        }
    );
    authorityVerificationReviewComplaints.duplicate = await createAuthorityReviewComplaint(
        "Authority review duplicate",
        { assignedWorkerId: verificationWorker._id }
    );
    authorityVerificationReviewComplaints.concurrent = await createAuthorityReviewComplaint(
        "Authority review concurrent",
        { assignedWorkerId: verificationWorker._id }
    );
    authorityVerificationReviewComplaints.decisions = {};
    for (const decision of ["Verified", "Inconclusive", "Rejected", "Reopened"]) {
        authorityVerificationReviewComplaints.decisions[decision] =
            await createAuthorityReviewComplaint(
                `Authority review ${decision.toLowerCase()}`,
                { assignedWorkerId: verificationWorker._id }
            );
    }

    const jwtSecret = crypto.randomBytes(32).toString("hex");
    tokens = {
        workerA: createToken(workerAId, "worker", jwtSecret),
        workerB: createToken(workerBId, "worker", jwtSecret),
        verificationWorker: createToken(verificationWorkerId, "worker", jwtSecret),
        citizen: createToken(citizenId, "citizen", jwtSecret),
        wrongRole: createToken(citizenId, "citizen", jwtSecret),
        otherCitizen: createToken(otherCitizenId, "citizen", jwtSecret),
        authority: createToken(authority._id, "authority", jwtSecret),
        admin: createToken(admin._id, "admin", jwtSecret)
    };

    const childEnvironment = { ...process.env };
    delete childEnvironment.MONGODB_URI;
    delete childEnvironment.PORT;
    testServerProcess = fork(testServerPath, [], {
        env: {
            ...childEnvironment,
            CIVICCONNECT_TEST_MONGODB_URI: testMongoUri,
            CIVICCONNECT_TEST_PORT: String(testPort),
            CIVICCONNECT_ALLOW_TEST_CLEANUP: "YES",
            JWT_SECRET: jwtSecret
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    await waitForTestServer(testServerProcess);

    fixtures = {
        workerAComplaints,
        workerBComplaints,
        workerProgressEvidenceComplaints,
        authorityComplaintFixtures,
        citizenVerificationComplaints,
        authorityVerificationReviewComplaints
    };
});

after(async () => {
    await stopTestServer();

    try {
        if (mongoose.connection.readyState === 1) {
            const cleanupOperations = [];
            if (recordedComplaintIds.length > 0) {
                cleanupOperations.push(
                    Complaint.deleteMany({ _id: { $in: recordedComplaintIds } })
                );
            }
            if (recordedUserIds.length > 0) {
                cleanupOperations.push(User.deleteMany({ _id: { $in: recordedUserIds } }));
            }
            const cleanupResults = await Promise.allSettled(cleanupOperations);
            if (cleanupResults.some((result) => result.status === "rejected")) {
                throw new Error("Unable to remove recorded worker workflow test documents");
            }
        }
    } finally {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    }
});

test("authority dashboard statistics require authority or admin authorization", async () => {
    const unauthenticated = await request("/api/authority/dashboard/stats");
    const workerResult = await request("/api/authority/dashboard/stats", {
        token: tokens.workerA
    });
    const citizenResult = await request("/api/authority/dashboard/stats", {
        token: tokens.wrongRole
    });
    const authorityResult = await request("/api/authority/dashboard/stats", {
        token: tokens.authority
    });
    const adminResult = await request("/api/authority/dashboard/stats", {
        token: tokens.admin
    });

    assert.equal(unauthenticated.response.status, 401);
    assert.equal(workerResult.response.status, 403);
    assert.equal(citizenResult.response.status, 403);
    assert.equal(authorityResult.response.status, 200);
    assert.equal(adminResult.response.status, 200);
});

test("authority dashboard statistics match database complaint counts", async () => {
    const { response, payload } = await request("/api/authority/dashboard/stats", {
        token: tokens.authority
    });

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload.data).sort(), [
        "countsByCategory",
        "countsByStatus",
        "totalComplaints"
    ]);

    const [expectedTotal, expectedStatuses, expectedCategories] = await Promise.all([
        Complaint.countDocuments({}),
        Promise.all(Complaint.schema.path("status").enumValues.map(async (status) => [
            status,
            await Complaint.countDocuments({ status })
        ])),
        Promise.all(Complaint.schema.path("category").enumValues.map(async (category) => [
            category,
            await Complaint.countDocuments({ category })
        ]))
    ]);

    assert.equal(payload.data.totalComplaints, expectedTotal);
    assert.deepEqual(payload.data.countsByStatus, Object.fromEntries(expectedStatuses));
    assert.deepEqual(payload.data.countsByCategory, Object.fromEntries(expectedCategories));
    assert.equal(Object.hasOwn(payload.data, "originalComplainantId"), false);
    assert.equal(Object.hasOwn(payload.data, "assignedWorkerId"), false);
});

test("authority complaint details require authority or admin authorization", async () => {
    const { assigned } = fixtures.authorityComplaintFixtures;
    const unauthenticated = await request(`/api/authority/complaints/${assigned._id}`);
    const workerResult = await request(`/api/authority/complaints/${assigned._id}`, {
        token: tokens.workerA
    });
    const citizenResult = await request(`/api/authority/complaints/${assigned._id}`, {
        token: tokens.wrongRole
    });

    assert.equal(unauthenticated.response.status, 401);
    assert.equal(workerResult.response.status, 403);
    assert.equal(citizenResult.response.status, 403);
});

test("authority and admin receive complaint details with only safe related-user fields", async () => {
    const { assigned } = fixtures.authorityComplaintFixtures;

    for (const token of [tokens.authority, tokens.admin]) {
        const { response, payload } = await request(
            `/api/authority/complaints/${assigned._id}`,
            { token }
        );
        const complaint = payload.data.complaint;

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(Object.keys(complaint).sort(), [
            "id",
            "title",
            "description",
            "category",
            "location",
            "images",
            "status",
            "originalComplainant",
            "assignedWorker",
            "createdAt",
            "updatedAt"
        ].sort());
        assert.equal(complaint.id, assigned._id.toString());
        assert.equal(complaint.title, "Authority detail assigned");
        assert.equal(complaint.description, assigned.description);
        assert.equal(complaint.category, "Road Damage");
        assert.deepEqual(complaint.location, {
            address: "Test-only location",
            latitude: 0,
            longitude: 0
        });
        assert.deepEqual(complaint.images, []);
        assert.equal(complaint.status, "Assigned");
        assert.deepEqual(complaint.originalComplainant, {
            id: citizenId.toString(),
            name: "Workflow Citizen"
        });
        assert.deepEqual(complaint.assignedWorker, {
            id: workerBId.toString(),
            name: "Workflow Worker B"
        });
        assert.deepEqual(Object.keys(complaint.originalComplainant).sort(), ["id", "name"]);
        assert.deepEqual(Object.keys(complaint.assignedWorker).sort(), ["id", "name"]);
        assert.equal(typeof complaint.createdAt, "string");
        assert.equal(typeof complaint.updatedAt, "string");
    }
});

test("authority complaint details reject invalid and nonexistent complaint IDs", async () => {
    const invalidIdResult = await request("/api/authority/complaints/not-an-object-id", {
        token: tokens.authority
    });
    const missingComplaintResult = await request(
        `/api/authority/complaints/${new mongoose.Types.ObjectId()}`,
        { token: tokens.authority }
    );

    assert.equal(invalidIdResult.response.status, 400);
    assert.equal(missingComplaintResult.response.status, 404);
});

test("authority complaint details return null for unassigned or unavailable users", async () => {
    const { unassigned, missingReferences } = fixtures.authorityComplaintFixtures;
    const unassignedResult = await request(
        `/api/authority/complaints/${unassigned._id}`,
        { token: tokens.authority }
    );
    const missingReferencesResult = await request(
        `/api/authority/complaints/${missingReferences._id}`,
        { token: tokens.authority }
    );

    assert.equal(unassignedResult.response.status, 200);
    assert.equal(missingReferencesResult.response.status, 200);
    assert.deepEqual(unassignedResult.payload.data.complaint.assignedWorker, null);
    assert.deepEqual(missingReferencesResult.payload.data.complaint.originalComplainant, null);
    assert.deepEqual(missingReferencesResult.payload.data.complaint.assignedWorker, null);
});

test("citizen verification requires authentication, citizen role, and complaint ownership", async () => {
    const { success } = fixtures.citizenVerificationComplaints;
    const pathname = `/api/complaints/${success._id}/citizen-verification`;
    const body = { response: "resolved" };
    const unauthenticated = await request(pathname, { method: "POST", body });
    const workerResult = await request(pathname, {
        token: tokens.workerA,
        method: "POST",
        body
    });
    const authorityResult = await request(pathname, {
        token: tokens.authority,
        method: "POST",
        body
    });
    const adminResult = await request(pathname, {
        token: tokens.admin,
        method: "POST",
        body
    });
    const otherCitizenResult = await request(pathname, {
        token: tokens.otherCitizen,
        method: "POST",
        body
    });

    assert.equal(unauthenticated.response.status, 401);
    assert.equal(workerResult.response.status, 403);
    assert.equal(authorityResult.response.status, 403);
    assert.equal(adminResult.response.status, 403);
    assert.equal(otherCitizenResult.response.status, 404);
});

test("original citizen submits verification with server-derived submitter and timestamp", async () => {
    const { success } = fixtures.citizenVerificationComplaints;
    const startedAt = Date.now();
    const { response, payload } = await request(
        `/api/complaints/${success._id}/citizen-verification`,
        {
            token: tokens.citizen,
            method: "POST",
            body: {
                response: "resolved",
                notes: "The repair is complete.",
                evidenceImages: ["https://example.test/citizen-evidence.jpg"]
            }
        }
    );
    const finishedAt = Date.now();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(Object.keys(payload.data.citizenVerification).sort(), [
        "response",
        "notes",
        "evidenceImages",
        "submittedAt"
    ].sort());
    assert.equal(payload.data.citizenVerification.response, "resolved");
    assert.equal(payload.data.citizenVerification.notes, "The repair is complete.");
    assert.deepEqual(
        payload.data.citizenVerification.evidenceImages,
        ["https://example.test/citizen-evidence.jpg"]
    );

    const submittedAt = Date.parse(payload.data.citizenVerification.submittedAt);
    assert.ok(submittedAt >= startedAt && submittedAt <= finishedAt);

    const savedComplaint = await Complaint.findById(success._id).select("citizenVerification");
    assert.equal(savedComplaint.citizenVerification.submittedBy.toString(), citizenId.toString());
    assert.equal(
        savedComplaint.citizenVerification.submittedAt.toISOString(),
        payload.data.citizenVerification.submittedAt
    );
});

test("citizen verification does not modify the assigned worker", async () => {
    const { assignedWorker } = fixtures.citizenVerificationComplaints;
    const assignedWorkerId = assignedWorker.assignedWorkerId.toString();
    const { response } = await request(
        `/api/complaints/${assignedWorker._id}/citizen-verification`,
        {
            token: tokens.citizen,
            method: "POST",
            body: { response: "resolved" }
        }
    );
    const savedComplaint = await Complaint.findById(assignedWorker._id)
        .select("assignedWorkerId");

    assert.equal(response.status, 200);
    assert.equal(savedComplaint.assignedWorkerId.toString(), assignedWorkerId);
});

test("citizen verification rejects invalid IDs, statuses, and duplicate submissions", async () => {
    const invalidIdResult = await request(
        "/api/complaints/not-an-object-id/citizen-verification",
        { token: tokens.citizen, method: "POST", body: { response: "resolved" } }
    );
    const { wrongStatus, duplicate } = fixtures.citizenVerificationComplaints;
    const wrongStatusResult = await request(
        `/api/complaints/${wrongStatus._id}/citizen-verification`,
        { token: tokens.citizen, method: "POST", body: { response: "resolved" } }
    );
    const duplicatePath = `/api/complaints/${duplicate._id}/citizen-verification`;
    const firstSubmission = await request(duplicatePath, {
        token: tokens.citizen,
        method: "POST",
        body: { response: "resolved", notes: "First submission" }
    });
    const duplicateSubmission = await request(duplicatePath, {
        token: tokens.citizen,
        method: "POST",
        body: { response: "not_resolved", notes: "Must not overwrite" }
    });
    const savedDuplicate = await Complaint.findById(duplicate._id).select("citizenVerification");

    assert.equal(invalidIdResult.response.status, 400);
    assert.equal(wrongStatusResult.response.status, 409);
    assert.equal(firstSubmission.response.status, 200);
    assert.equal(duplicateSubmission.response.status, 409);
    assert.equal(savedDuplicate.citizenVerification.response, "resolved");
    assert.equal(savedDuplicate.citizenVerification.notes, "First submission");
});

test("concurrent citizen verification submissions cannot overwrite each other", async () => {
    const { concurrent } = fixtures.citizenVerificationComplaints;
    const pathname = `/api/complaints/${concurrent._id}/citizen-verification`;
    const submissions = [
        { response: "resolved", notes: "Concurrent submission A" },
        { response: "not_resolved", notes: "Concurrent submission B" }
    ];
    const results = await Promise.all(submissions.map((body) => request(pathname, {
        token: tokens.citizen,
        method: "POST",
        body
    })));
    const savedComplaint = await Complaint.findById(concurrent._id).select("citizenVerification");
    const successfulResult = results.find(({ response }) => response.status === 200);
    const rejectedResult = results.find(({ response }) => response.status === 409);

    assert.ok(successfulResult);
    assert.ok(rejectedResult);
    assert.equal(savedComplaint.citizenVerification.response,
        successfulResult.payload.data.citizenVerification.response);
    assert.equal(savedComplaint.citizenVerification.notes,
        successfulResult.payload.data.citizenVerification.notes);
    assert.equal(savedComplaint.citizenVerification.submittedBy.toString(), citizenId.toString());
});

test("citizen verification rejects unexpected fields and invalid values", async () => {
    const { invalidInput } = fixtures.citizenVerificationComplaints;
    const pathname = `/api/complaints/${invalidInput._id}/citizen-verification`;
    const invalidBodies = [
        {
            response: "resolved",
            status: "Verified",
            originalComplainantId: otherCitizenId.toString(),
            submittedBy: otherCitizenId.toString(),
            submittedAt: new Date(0).toISOString()
        },
        { response: "pending" },
        { response: "resolved", notes: 12 },
        { response: "resolved", notes: "x".repeat(1001) },
        { response: "resolved", evidenceImages: ["javascript:alert(1)"] },
        { response: "resolved", evidenceImages: "https://example.test/image.jpg" }
    ];
    const results = await Promise.all(invalidBodies.map((body) => request(pathname, {
        token: tokens.wrongRole,
        method: "POST",
        body
    })));

    assert.deepEqual(results.map(({ response }) => response.status), [
        400,
        400,
        400,
        400,
        400,
        400
    ]);

    const unchangedComplaint = await Complaint.findById(invalidInput._id)
        .select("status originalComplainantId citizenVerification");
    assert.equal(unchangedComplaint.status, "Evidence Verification Pending");
    assert.equal(unchangedComplaint.originalComplainantId.toString(), citizenId.toString());
    assert.equal(unchangedComplaint.citizenVerification, null);
});

test("Worker A sees only complaints assigned to Worker A", async () => {
    const { response, payload } = await request("/api/complaints/assigned", {
        token: tokens.workerA
    });

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(
        new Set(payload.data.complaints.map((complaint) => complaint.id)),
        new Set(Object.values(fixtures.workerAComplaints)
            .map((complaint) => complaint._id.toString()))
    );
});

test("Worker B sees only complaints assigned to Worker B", async () => {
    const { response, payload } = await request("/api/complaints/assigned", {
        token: tokens.workerB
    });

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(
        new Set(payload.data.complaints.map((complaint) => complaint.id)),
        new Set(Object.values(fixtures.workerBComplaints)
            .map((complaint) => complaint._id.toString()))
    );
});

test("a worker cannot start or claim completion of another worker's complaint", async () => {
    const { workerBComplaints } = fixtures;
    const startResult = await request(
        `/api/complaints/${workerBComplaints.assigned._id}/start`,
        { token: tokens.workerA, method: "PATCH" }
    );
    const claimResult = await request(
        `/api/complaints/${workerBComplaints.inProgress._id}/claim-completion`,
        { token: tokens.workerA, method: "PATCH" }
    );

    assert.equal(startResult.response.status, 404);
    assert.equal(claimResult.response.status, 404);
});

test("worker complaint transitions move through the supported statuses", async () => {
    const { workerAComplaints } = fixtures;
    const startResult = await request(
        `/api/complaints/${workerAComplaints.assignedForStart._id}/start`,
        { token: tokens.workerA, method: "PATCH" }
    );
    const claimResult = await request(
        `/api/complaints/${workerAComplaints.assignedForStart._id}/claim-completion`,
        { token: tokens.workerA, method: "PATCH" }
    );

    assert.equal(startResult.response.status, 200);
    assert.equal(startResult.payload.data.complaint.status, "In Progress");
    assert.equal(claimResult.response.status, 200);
    assert.equal(claimResult.payload.data.complaint.status, "Work Claimed Completed");
});

test("worker status endpoints reject invalid status transitions", async () => {
    const { workerAComplaints } = fixtures;
    const startResult = await request(
        `/api/complaints/${workerAComplaints.inProgressForInvalidStart._id}/start`,
        { token: tokens.workerA, method: "PATCH" }
    );
    const claimResult = await request(
        `/api/complaints/${workerAComplaints.assignedForInvalidClaim._id}/claim-completion`,
        { token: tokens.workerA, method: "PATCH" }
    );

    assert.equal(startResult.response.status, 409);
    assert.equal(claimResult.response.status, 409);
});

test("worker endpoints require authentication and the worker role", async () => {
    const { workerAComplaints } = fixtures;
    const unauthenticatedRequests = [
        request("/api/complaints/assigned"),
        request(`/api/complaints/${workerAComplaints.assignedForStart._id}/start`, {
            method: "PATCH"
        }),
        request(`/api/complaints/${workerAComplaints.inProgressForClaim._id}/claim-completion`, {
            method: "PATCH"
        })
    ];
    const unauthenticatedResults = await Promise.all(unauthenticatedRequests);

    assert.deepEqual(
        unauthenticatedResults.map(({ response }) => response.status),
        [401, 401, 401]
    );

    const wrongRoleRequests = [
        request("/api/complaints/assigned", { token: tokens.wrongRole }),
        request(`/api/complaints/${workerAComplaints.assignedForStart._id}/start`, {
            token: tokens.wrongRole,
            method: "PATCH"
        }),
        request(`/api/complaints/${workerAComplaints.inProgressForClaim._id}/claim-completion`, {
            token: tokens.wrongRole,
            method: "PATCH"
        })
    ];
    const wrongRoleResults = await Promise.all(wrongRoleRequests);

    assert.deepEqual(
        wrongRoleResults.map(({ response }) => response.status),
        [403, 403, 403]
    );
});

test("worker mutation endpoints reject non-empty and malformed JSON bodies", async () => {
    const { workerAComplaints } = fixtures;
    const bodyResults = await Promise.all([
        request(`/api/complaints/${workerAComplaints.assignedForStart._id}/start`, {
            token: tokens.workerA,
            method: "PATCH",
            body: { status: "In Progress" }
        }),
        request(`/api/complaints/${workerAComplaints.assignedForInvalidClaim._id}/claim-completion`, {
            token: tokens.workerA,
            method: "PATCH",
            body: ["unexpected"]
        }),
        request(`/api/complaints/${workerAComplaints.assignedForStart._id}/start`, {
            token: tokens.workerA,
            method: "PATCH",
            rawBody: "{"
        })
    ]);

    assert.deepEqual(
        bodyResults.map(({ response }) => response.status),
        [400, 400, 400]
    );
});

test("assigned complaint responses expose safe fields and correct pagination", async () => {
    const { response, payload } = await request("/api/complaints/assigned?page=2&limit=2", {
        token: tokens.workerA
    });

    assert.equal(response.status, 200);
    assert.deepEqual(payload.data.pagination, {
        currentPage: 2,
        totalPages: 3,
        totalComplaints: 5,
        limit: 2
    });
    assert.equal(payload.data.complaints.length, 2);

    for (const complaint of payload.data.complaints) {
        assert.deepEqual(Object.keys(complaint).sort(), [...safeComplaintFields].sort());
        assert.deepEqual(Object.keys(complaint.location).sort(), [
            "address",
            "latitude",
            "longitude"
        ]);
        assert.equal(Object.hasOwn(complaint, "assignedWorkerId"), false);
        assert.equal(Object.hasOwn(complaint, "originalComplainantId"), false);
    }
});

test("assigned complaint pagination rejects invalid limits", async () => {
    const { response, payload } = await request("/api/complaints/assigned?page=1&limit=51", {
        token: tokens.workerA
    });

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
});

test("worker progress evidence requires authentication and the worker role", async () => {
    const { success } = fixtures.workerProgressEvidenceComplaints;
    const pathname = `/api/complaints/${success._id}/progress-evidence`;
    const body = { note: "Inspected the damaged streetlight." };
    const unauthenticated = await request(pathname, { method: "POST", body });
    const wrongRoleRequests = [
        request(pathname, { token: tokens.citizen, method: "POST", body }),
        request(pathname, { token: tokens.authority, method: "POST", body }),
        request(pathname, { token: tokens.admin, method: "POST", body })
    ];
    const wrongRoleResults = await Promise.all(wrongRoleRequests);

    assert.equal(unauthenticated.response.status, 401);
    assert.deepEqual(
        wrongRoleResults.map(({ response }) => response.status),
        [403, 403, 403]
    );

    const unchangedComplaint = await Complaint.findById(success._id)
        .select("workerProgressEvidence citizenVerification");
    assert.equal(unchangedComplaint.workerProgressEvidence.length, 0);
    assert.equal(unchangedComplaint.citizenVerification, null);
});

test("only the currently assigned worker can submit progress evidence", async () => {
    const { wrongWorker } = fixtures.workerProgressEvidenceComplaints;
    const { response } = await request(
        `/api/complaints/${wrongWorker._id}/progress-evidence`,
        {
            token: tokens.workerA,
            method: "POST",
            body: { note: "Attempted submission by a different worker." }
        }
    );

    assert.equal(response.status, 404);
    const unchangedComplaint = await Complaint.findById(wrongWorker._id)
        .select("workerProgressEvidence assignedWorkerId");
    assert.equal(unchangedComplaint.workerProgressEvidence.length, 0);
    assert.equal(
        unchangedComplaint.assignedWorkerId.toString(),
        verificationWorkerId.toString()
    );
});

test("worker progress evidence requires a valid complaint ID and In Progress status", async () => {
    const invalidId = await request(
        "/api/complaints/not-an-object-id/progress-evidence",
        {
            token: tokens.verificationWorker,
            method: "POST",
            body: { note: "Inspecting the issue." }
        }
    );
    const missingComplaint = await request(
        `/api/complaints/${new mongoose.Types.ObjectId()}/progress-evidence`,
        {
            token: tokens.verificationWorker,
            method: "POST",
            body: { note: "Inspecting the issue." }
        }
    );
    const { assigned, completed } = fixtures.workerProgressEvidenceComplaints;
    const assignedResult = await request(
        `/api/complaints/${assigned._id}/progress-evidence`,
        {
            token: tokens.verificationWorker,
            method: "POST",
            body: { note: "The work has not started." }
        }
    );
    const completedResult = await request(
        `/api/complaints/${completed._id}/progress-evidence`,
        {
            token: tokens.verificationWorker,
            method: "POST",
            body: { note: "Completion was already claimed." }
        }
    );

    assert.equal(invalidId.response.status, 400);
    assert.equal(missingComplaint.response.status, 404);
    assert.equal(assignedResult.response.status, 409);
    assert.equal(completedResult.response.status, 409);

    const unchangedComplaints = await Complaint.find({
        _id: { $in: [assigned._id, completed._id] }
    }).select("workerProgressEvidence");
    assert.ok(unchangedComplaints.every((complaint) => (
        complaint.workerProgressEvidence.length === 0
    )));
});

test("worker progress evidence rejects invalid bodies, extra fields, and invalid images", async () => {
    const { invalidInput } = fixtures.workerProgressEvidenceComplaints;
    const pathname = `/api/complaints/${invalidInput._id}/progress-evidence`;
    const invalidBodies = [
        undefined,
        null,
        [],
        {},
        { note: "" },
        { note: "   " },
        { note: 12 },
        { note: "x".repeat(1001) },
        { note: "Progress update", evidenceImages: "https://example.test/image.jpg" },
        {
            note: "Progress update",
            evidenceImages: Array.from(
                { length: 6 },
                (_, index) => `https://example.test/image-${index}.jpg`
            )
        },
        { note: "Progress update", evidenceImages: ["javascript:alert(1)"] },
        { note: "Progress update", evidenceImages: [12] },
        { note: "Progress update", submittedBy: verificationWorkerId.toString() },
        { note: "Progress update", submittedAt: new Date(0).toISOString() },
        { note: "Progress update", status: "In Progress" },
        { note: "Progress update", assignedWorkerId: verificationWorkerId.toString() },
        { note: "Progress update", citizenVerification: { response: "resolved" } },
        { note: "Progress update", workerProgressEvidence: [] }
    ];
    const results = await Promise.all(invalidBodies.map((body) => request(pathname, {
        token: tokens.verificationWorker,
        method: "POST",
        body
    })));

    assert.deepEqual(
        results.map(({ response }) => response.status),
        Array(invalidBodies.length).fill(400)
    );

    const unchangedComplaint = await Complaint.findById(invalidInput._id)
        .select("workerProgressEvidence citizenVerification status");
    assert.equal(unchangedComplaint.workerProgressEvidence.length, 0);
    assert.equal(unchangedComplaint.citizenVerification, null);
    assert.equal(unchangedComplaint.status, "In Progress");
});

test("assigned worker can append safe progress evidence while work is in progress", async () => {
    const { success } = fixtures.workerProgressEvidenceComplaints;
    const pathname = `/api/complaints/${success._id}/progress-evidence`;
    const startedAt = Date.now();
    const firstResult = await request(pathname, {
        token: tokens.verificationWorker,
        method: "POST",
        body: {
            note: "  Inspected and replaced the damaged streetlight.  ",
            evidenceImages: ["  https://example.test/progress-one.jpg  "]
        }
    });
    const finishedAt = Date.now();

    assert.equal(firstResult.response.status, 200);
    assert.equal(firstResult.payload.success, true);
    const complaint = firstResult.payload.data.complaint;
    assert.deepEqual(Object.keys(complaint).sort(), [
        "id",
        "progressEvidence",
        "status"
    ]);
    assert.deepEqual(Object.keys(complaint.progressEvidence).sort(), [
        "evidenceImages",
        "note",
        "submittedAt",
        "submittedBy"
    ]);
    assert.equal(complaint.id, success._id.toString());
    assert.equal(complaint.status, "In Progress");
    assert.equal(complaint.progressEvidence.note, "Inspected and replaced the damaged streetlight.");
    assert.deepEqual(complaint.progressEvidence.evidenceImages, [
        "https://example.test/progress-one.jpg"
    ]);
    assert.equal(complaint.progressEvidence.submittedBy, verificationWorkerId.toString());
    const submittedAt = Date.parse(complaint.progressEvidence.submittedAt);
    assert.ok(submittedAt >= startedAt && submittedAt <= finishedAt);

    const secondResult = await request(pathname, {
        token: tokens.verificationWorker,
        method: "POST",
        body: { note: "Follow-up inspection completed." }
    });
    assert.equal(secondResult.response.status, 200);
    assert.deepEqual(secondResult.payload.data.complaint.progressEvidence.evidenceImages, []);

    const savedComplaint = await Complaint.findById(success._id)
        .select("status assignedWorkerId workerProgressEvidence citizenVerification");
    assert.equal(savedComplaint.status, "In Progress");
    assert.equal(savedComplaint.assignedWorkerId.toString(), verificationWorkerId.toString());
    assert.equal(savedComplaint.workerProgressEvidence.length, 2);
    assert.equal(
        savedComplaint.workerProgressEvidence[0].note,
        "Inspected and replaced the damaged streetlight."
    );
    assert.deepEqual(
        savedComplaint.workerProgressEvidence[0].evidenceImages,
        ["https://example.test/progress-one.jpg"]
    );
    assert.equal(savedComplaint.workerProgressEvidence[1].note, "Follow-up inspection completed.");
    assert.equal(savedComplaint.workerProgressEvidence[0].submittedBy.toString(),
        verificationWorkerId.toString());
    assert.equal(savedComplaint.workerProgressEvidence[1].submittedBy.toString(),
        verificationWorkerId.toString());
    assert.equal(savedComplaint.citizenVerification, null);
});

test("worker progress evidence rejects the 51st entry without changing existing evidence", async () => {
    const complaint = await createComplaint(
        "Worker progress evidence entry limit",
        verificationWorkerId,
        "In Progress",
        citizenId
    );
    const existingEvidence = Array.from({ length: 50 }, (_, index) => ({
        note: `Existing progress entry ${index + 1}`,
        evidenceImages: [],
        submittedAt: new Date(index * 1000),
        submittedBy: verificationWorkerId
    }));
    const seedResult = await Complaint.updateOne(
        { _id: complaint._id, assignedWorkerId: verificationWorkerId, status: "In Progress" },
        { $set: { workerProgressEvidence: existingEvidence } }
    );
    assert.equal(seedResult.matchedCount, 1);

    const before = await Complaint.findById(complaint._id)
        .select("status workerProgressEvidence")
        .lean();
    const result = await request(
        `/api/complaints/${complaint._id}/progress-evidence`,
        {
            token: tokens.verificationWorker,
            method: "POST",
            body: { note: "This 51st entry must be rejected." }
        }
    );
    const afterRequest = await Complaint.findById(complaint._id)
        .select("status workerProgressEvidence")
        .lean();

    assert.equal(result.response.status, 409);
    assert.equal(result.payload.message, "Progress evidence limit of 50 entries has been reached");
    assert.equal(afterRequest.status, "In Progress");
    assert.equal(afterRequest.workerProgressEvidence.length, 50);
    const normalizeEvidence = (entries) => entries.map((entry) => ({
        note: entry.note,
        evidenceImages: entry.evidenceImages,
        submittedAt: entry.submittedAt.toISOString(),
        submittedBy: entry.submittedBy.toString()
    }));
    assert.deepEqual(
        normalizeEvidence(afterRequest.workerProgressEvidence),
        normalizeEvidence(before.workerProgressEvidence)
    );
});

test("worker progress evidence and completion claims remain safe when submitted concurrently", async () => {
    const { concurrent } = fixtures.workerProgressEvidenceComplaints;
    const evidenceRequest = request(
        `/api/complaints/${concurrent._id}/progress-evidence`,
        {
            token: tokens.verificationWorker,
            method: "POST",
            body: { note: "Progress evidence submitted during completion claim." }
        }
    );
    const completionRequest = request(
        `/api/complaints/${concurrent._id}/claim-completion`,
        { token: tokens.verificationWorker, method: "PATCH" }
    );
    const [evidenceResult, completionResult] = await Promise.all([
        evidenceRequest,
        completionRequest
    ]);

    assert.ok([200, 409].includes(evidenceResult.response.status));
    assert.equal(completionResult.response.status, 200);
    if (evidenceResult.response.status === 200) {
        assert.equal(evidenceResult.payload.data.complaint.status, "In Progress");
    }

    const finalComplaint = await Complaint.findById(concurrent._id)
        .select("status assignedWorkerId workerProgressEvidence")
        .lean();
    assert.equal(finalComplaint.status, "Work Claimed Completed");
    assert.equal(finalComplaint.assignedWorkerId.toString(), verificationWorkerId.toString());
    assert.equal(
        finalComplaint.workerProgressEvidence.length,
        evidenceResult.response.status === 200 ? 1 : 0
    );
    if (evidenceResult.response.status === 200) {
        assert.equal(
            finalComplaint.workerProgressEvidence[0].submittedBy.toString(),
            verificationWorkerId.toString()
        );
    }
});

test("authority verification review requires authority or admin authorization", async () => {
    const { authorization } = fixtures.authorityVerificationReviewComplaints;
    const pathname = `/api/authority/complaints/${authorization._id}/verification-review`;
    const body = { decision: "Verified" };
    const unauthenticated = await request(pathname, { method: "PATCH", body });
    const citizenResult = await request(pathname, {
        token: tokens.citizen,
        method: "PATCH",
        body
    });
    const workerResult = await request(pathname, {
        token: tokens.workerA,
        method: "PATCH",
        body
    });

    assert.equal(unauthenticated.response.status, 401);
    assert.equal(citizenResult.response.status, 403);
    assert.equal(workerResult.response.status, 403);

    const unchangedComplaint = await Complaint.findById(authorization._id)
        .select("status authorityVerificationReviews");
    assert.equal(unchangedComplaint.status, "Evidence Verification Pending");
    assert.equal(unchangedComplaint.authorityVerificationReviews.length, 0);
});

test("authority verification review rejects invalid targets, status, verification, and bodies", async () => {
    const invalidIdResult = await request(
        "/api/authority/complaints/not-an-object-id/verification-review",
        { token: tokens.authority, method: "PATCH", body: { decision: "Verified" } }
    );
    const nonexistentResult = await request(
        `/api/authority/complaints/${new mongoose.Types.ObjectId()}/verification-review`,
        { token: tokens.authority, method: "PATCH", body: { decision: "Verified" } }
    );
    const { wrongStatus, missingCitizenVerification, invalidInput } =
        fixtures.authorityVerificationReviewComplaints;
    const wrongStatusResult = await request(
        `/api/authority/complaints/${wrongStatus._id}/verification-review`,
        { token: tokens.authority, method: "PATCH", body: { decision: "Verified" } }
    );
    const missingVerificationResult = await request(
        `/api/authority/complaints/${missingCitizenVerification._id}/verification-review`,
        { token: tokens.authority, method: "PATCH", body: { decision: "Verified" } }
    );

    assert.equal(invalidIdResult.response.status, 400);
    assert.equal(nonexistentResult.response.status, 404);
    assert.equal(wrongStatusResult.response.status, 409);
    assert.equal(missingVerificationResult.response.status, 409);

    const pathname = `/api/authority/complaints/${invalidInput._id}/verification-review`;
    const invalidRequests = [
        request(pathname, { token: tokens.authority, method: "PATCH" }),
        request(pathname, { token: tokens.authority, method: "PATCH", body: null }),
        request(pathname, { token: tokens.authority, method: "PATCH", body: [] }),
        request(pathname, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: "Verified", status: "Verified" }
        }),
        request(pathname, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: "Verified", reviewedBy: authorityId.toString() }
        }),
        request(pathname, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: "Verified", reviewedAt: new Date(0).toISOString() }
        }),
        request(pathname, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: "verified" }
        }),
        request(pathname, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: 12 }
        }),
        request(pathname, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: "Verified", reason: 12 }
        }),
        request(pathname, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: "Verified", reason: "x".repeat(1001) }
        })
    ];
    const invalidResults = await Promise.all(invalidRequests);

    assert.deepEqual(
        invalidResults.map(({ response }) => response.status),
        Array(invalidRequests.length).fill(400)
    );

    const unchangedComplaint = await Complaint.findById(invalidInput._id)
        .select("status authorityVerificationReviews");
    assert.equal(unchangedComplaint.status, "Evidence Verification Pending");
    assert.equal(unchangedComplaint.authorityVerificationReviews.length, 0);
});

test("authority and admin can submit every verification decision with safe responses", async () => {
    const { decisions } = fixtures.authorityVerificationReviewComplaints;
    const expectedDecisions = ["Verified", "Inconclusive", "Rejected", "Reopened"];

    for (const [index, decision] of expectedDecisions.entries()) {
        const complaint = decisions[decision];
        const reviewer = index % 2 === 0
            ? { token: tokens.authority, id: authorityId }
            : { token: tokens.admin, id: adminId };
        const body = { decision };
        if (index === 0) {
            body.reason = "  Citizen evidence confirms the issue is resolved.  ";
        }

        const startedAt = Date.now();
        const { response, payload } = await request(
            `/api/authority/complaints/${complaint._id}/verification-review`,
            { token: reviewer.token, method: "PATCH", body }
        );
        const finishedAt = Date.now();
        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(Object.keys(payload.data), ["complaint"]);
        const review = payload.data.complaint.verificationReview;

        assert.deepEqual(Object.keys(payload.data.complaint).sort(), [
            "id",
            "status",
            "verificationReview"
        ]);
        assert.deepEqual(
            Object.keys(review).sort(),
            index === 0
                ? ["decision", "reviewedBy", "reviewedAt", "reason"].sort()
                : ["decision", "reviewedBy", "reviewedAt"].sort()
        );
        assert.equal(payload.data.complaint.id, complaint._id.toString());
        assert.equal(payload.data.complaint.status, decision);
        assert.equal(review.decision, decision);
        assert.equal(review.reviewedBy, reviewer.id.toString());
        if (index === 0) {
            assert.equal(review.reason, "Citizen evidence confirms the issue is resolved.");
        }
        const reviewedAt = Date.parse(review.reviewedAt);
        assert.ok(reviewedAt >= startedAt && reviewedAt <= finishedAt);
        assert.equal(Object.hasOwn(payload.data.complaint, "citizenVerification"), false);
        assert.equal(Object.hasOwn(review, "email"), false);
        assert.equal(Object.hasOwn(review, "password"), false);

        const savedComplaint = await Complaint.findById(complaint._id)
            .select("status authorityVerificationReviews");
        assert.equal(savedComplaint.status, decision);
        assert.equal(savedComplaint.authorityVerificationReviews.length, 1);
        assert.equal(
            savedComplaint.authorityVerificationReviews[0].reviewedBy.toString(),
            reviewer.id.toString()
        );
    }
});

test("authority verification review appends history and preserves existing complaint data", async () => {
    const { history } = fixtures.authorityVerificationReviewComplaints;
    const before = await Complaint.findById(history._id).lean();
    const { response, payload } = await request(
        `/api/authority/complaints/${history._id}/verification-review`,
        {
            token: tokens.admin,
            method: "PATCH",
            body: { decision: "Verified", reason: "Follow-up review" }
        }
    );
    const afterReview = await Complaint.findById(history._id).lean();

    assert.equal(response.status, 200);
    assert.equal(afterReview.status, "Verified");
    assert.equal(afterReview.authorityVerificationReviews.length, 2);
    assert.equal(afterReview.authorityVerificationReviews[0].decision, "Reopened");
    assert.equal(
        afterReview.authorityVerificationReviews[0].reviewedBy.toString(),
        before.authorityVerificationReviews[0].reviewedBy.toString()
    );
    assert.equal(
        afterReview.authorityVerificationReviews[0].reviewedAt.toISOString(),
        before.authorityVerificationReviews[0].reviewedAt.toISOString()
    );
    assert.equal(afterReview.authorityVerificationReviews[0].reason, "Prior review entry");
    assert.equal(afterReview.authorityVerificationReviews[1].decision, "Verified");
    assert.equal(afterReview.authorityVerificationReviews[1].reason, "Follow-up review");
    assert.equal(
        afterReview.authorityVerificationReviews[1].reviewedBy.toString(),
        adminId.toString()
    );
    assert.deepEqual(afterReview.citizenVerification.evidenceImages,
        before.citizenVerification.evidenceImages);
    assert.equal(afterReview.citizenVerification.response, before.citizenVerification.response);
    assert.equal(afterReview.citizenVerification.notes, before.citizenVerification.notes);
    assert.equal(
        afterReview.citizenVerification.submittedAt.toISOString(),
        before.citizenVerification.submittedAt.toISOString()
    );
    assert.equal(
        afterReview.citizenVerification.submittedBy.toString(),
        before.citizenVerification.submittedBy.toString()
    );
    assert.equal(afterReview.originalComplainantId.toString(),
        before.originalComplainantId.toString());
    assert.equal(afterReview.assignedWorkerId.toString(), before.assignedWorkerId.toString());
    assert.equal(afterReview.title, before.title);
    assert.equal(afterReview.description, before.description);
    assert.deepEqual(afterReview.images, before.images);
    assert.deepEqual(Object.keys(payload.data.complaint).sort(), [
        "id",
        "status",
        "verificationReview"
    ]);
});

test("authority verification review rejects duplicate and concurrent overwrites", async () => {
    const { duplicate, concurrent } = fixtures.authorityVerificationReviewComplaints;
    const duplicatePath = `/api/authority/complaints/${duplicate._id}/verification-review`;
    const firstReview = await request(duplicatePath, {
        token: tokens.authority,
        method: "PATCH",
        body: { decision: "Verified" }
    });
    const duplicateReview = await request(duplicatePath, {
        token: tokens.admin,
        method: "PATCH",
        body: { decision: "Rejected" }
    });

    assert.equal(firstReview.response.status, 200);
    assert.equal(duplicateReview.response.status, 409);

    const duplicateState = await Complaint.findById(duplicate._id)
        .select("status authorityVerificationReviews");
    assert.equal(duplicateState.status, "Verified");
    assert.equal(duplicateState.authorityVerificationReviews.length, 1);
    assert.equal(duplicateState.authorityVerificationReviews[0].decision, "Verified");

    const concurrentPath = `/api/authority/complaints/${concurrent._id}/verification-review`;
    const concurrentRequests = [
        request(concurrentPath, {
            token: tokens.authority,
            method: "PATCH",
            body: { decision: "Verified" }
        }),
        request(concurrentPath, {
            token: tokens.admin,
            method: "PATCH",
            body: { decision: "Reopened" }
        })
    ];
    const concurrentResults = await Promise.all(concurrentRequests);
    const successfulResult = concurrentResults.find(({ response }) => response.status === 200);
    const conflictResult = concurrentResults.find(({ response }) => response.status === 409);
    const concurrentState = await Complaint.findById(concurrent._id)
        .select("status authorityVerificationReviews");

    assert.ok(successfulResult);
    assert.ok(conflictResult);
    assert.equal(
        concurrentState.status,
        successfulResult.payload.data.complaint.verificationReview.decision
    );
    assert.equal(concurrentState.authorityVerificationReviews.length, 1);
    assert.equal(
        concurrentState.authorityVerificationReviews[0].decision,
        concurrentState.status
    );
});
