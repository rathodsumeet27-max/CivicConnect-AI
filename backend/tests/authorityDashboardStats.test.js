"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Complaint = require("../src/models/Complaint");
const { getDashboardStats } = require("../src/controllers/authorityController");

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

async function withAggregateResult(result, callback) {
    const originalAggregate = Complaint.aggregate;
    Complaint.aggregate = () => Promise.resolve(result);
    try {
        return await callback();
    } finally {
        Complaint.aggregate = originalAggregate;
    }
}

async function withAggregateError(callback) {
    const originalAggregate = Complaint.aggregate;
    Complaint.aggregate = () => Promise.reject(new Error("Synthetic aggregation failure"));
    try {
        return await callback();
    } finally {
        Complaint.aggregate = originalAggregate;
    }
}

test("dashboard stats deny citizens and workers before aggregation", async () => {
    let aggregateCalls = 0;
    const originalAggregate = Complaint.aggregate;
    Complaint.aggregate = () => {
        aggregateCalls += 1;
        return Promise.resolve([]);
    };

    try {
        for (const role of ["citizen", "worker"]) {
            const response = createResponse();
            await getDashboardStats({ user: { role } }, response);
            assert.equal(response.statusCode, 403);
            assert.equal(response.body.success, false);
        }
        assert.equal(aggregateCalls, 0);
    } finally {
        Complaint.aggregate = originalAggregate;
    }
});

test("dashboard stats return zero for every status and category when empty", async () => {
    await withAggregateResult(
        [{ total: [], byStatus: [], byCategory: [] }],
        async () => {
            const response = createResponse();
            await getDashboardStats({ user: { role: "authority" } }, response);

            assert.equal(response.statusCode, 200);
            assert.equal(response.body.data.totalComplaints, 0);
            for (const count of Object.values(response.body.data.countsByStatus)) {
                assert.equal(count, 0);
            }
            for (const count of Object.values(response.body.data.countsByCategory)) {
                assert.equal(count, 0);
            }
        }
    );
});

test("dashboard stats map aggregation counts to the documented response", async () => {
    await withAggregateResult(
        [{
            total: [{ count: 3 }],
            byStatus: [
                { _id: "Submitted", count: 2 },
                { _id: "Assigned", count: 1 }
            ],
            byCategory: [{ _id: "Garbage", count: 3 }]
        }],
        async () => {
            const response = createResponse();
            await getDashboardStats({ user: { role: "admin" } }, response);

            assert.equal(response.statusCode, 200);
            assert.deepEqual(Object.keys(response.body.data).sort(), [
                "countsByCategory",
                "countsByStatus",
                "totalComplaints"
            ]);
            assert.equal(response.body.data.totalComplaints, 3);
            assert.equal(response.body.data.countsByStatus.Submitted, 2);
            assert.equal(response.body.data.countsByStatus.Assigned, 1);
            assert.equal(response.body.data.countsByStatus["In Progress"], 0);
            assert.equal(response.body.data.countsByCategory.Garbage, 3);
            assert.equal(response.body.data.countsByCategory["Road Damage"], 0);
        }
    );
});

test("dashboard stats handle aggregation errors without exposing database details", async () => {
    await withAggregateError(async () => {
        const response = createResponse();
        await getDashboardStats({ user: { role: "authority" } }, response);

        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, {
            success: false,
            message: "Unable to fetch dashboard statistics at this time"
        });
    });
});
