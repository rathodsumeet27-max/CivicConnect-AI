"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Complaint = require("../src/models/Complaint");
const { reviewCitizenVerification } = require("../src/controllers/authorityController");

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

function createQuery(leanResult) {
    return {
        select() {
            return this;
        },
        lean() {
            return leanResult;
        }
    };
}

test("verification review rejects a malformed authenticated subject before database access", async () => {
    const originalFindOneAndUpdate = Complaint.findOneAndUpdate;
    let updateCalled = false;
    Complaint.findOneAndUpdate = () => {
        updateCalled = true;
        return Promise.resolve(null);
    };

    try {
        const response = createResponse();
        await reviewCitizenVerification(
            {
                user: { id: "not-an-object-id", role: "authority" },
                params: { id: "507f1f77bcf86cd799439011" },
                body: { decision: "Verified" }
            },
            response
        );

        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.body, {
            success: false,
            message: "Authentication required or token is invalid"
        });
        assert.equal(updateCalled, false);
    } finally {
        Complaint.findOneAndUpdate = originalFindOneAndUpdate;
    }
});

test("verification review returns a generic error when the atomic update fails", async () => {
    const originalFindOneAndUpdate = Complaint.findOneAndUpdate;
    Complaint.findOneAndUpdate = () => createQuery(
        Promise.reject(new Error("Synthetic atomic update failure"))
    );

    try {
        const response = createResponse();
        await reviewCitizenVerification(
            {
                user: { id: "507f1f77bcf86cd799439012", role: "authority" },
                params: { id: "507f1f77bcf86cd799439011" },
                body: { decision: "Verified" }
            },
            response
        );

        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, {
            success: false,
            message: "Unable to review citizen verification at this time"
        });
    } finally {
        Complaint.findOneAndUpdate = originalFindOneAndUpdate;
    }
});

test("verification review returns a generic error when the fallback lookup fails", async () => {
    const originalFindOneAndUpdate = Complaint.findOneAndUpdate;
    const originalFindById = Complaint.findById;
    Complaint.findOneAndUpdate = () => createQuery(Promise.resolve(null));
    Complaint.findById = () => createQuery(
        Promise.reject(new Error("Synthetic fallback lookup failure"))
    );

    try {
        const response = createResponse();
        await reviewCitizenVerification(
            {
                user: { id: "507f1f77bcf86cd799439012", role: "authority" },
                params: { id: "507f1f77bcf86cd799439011" },
                body: { decision: "Verified" }
            },
            response
        );

        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, {
            success: false,
            message: "Unable to review citizen verification at this time"
        });
    } finally {
        Complaint.findOneAndUpdate = originalFindOneAndUpdate;
        Complaint.findById = originalFindById;
    }
});
