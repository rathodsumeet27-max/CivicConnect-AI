"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Complaint = require("../src/models/Complaint");
const { submitCitizenVerification } = require("../src/controllers/complaintController");

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

test("citizen verification database errors return a generic response", async () => {
    const originalFindOneAndUpdate = Complaint.findOneAndUpdate;
    Complaint.findOneAndUpdate = () => ({
        select() {
            return this;
        },
        lean() {
            return Promise.reject(new Error("Synthetic database failure"));
        }
    });

    try {
        const response = createResponse();
        await submitCitizenVerification(
            {
                user: { id: "507f1f77bcf86cd799439011", role: "citizen" },
                params: { id: "507f1f77bcf86cd799439012" },
                body: { response: "resolved" }
            },
            response
        );

        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, {
            success: false,
            message: "Unable to submit citizen verification at this time"
        });
    } finally {
        Complaint.findOneAndUpdate = originalFindOneAndUpdate;
    }
});
