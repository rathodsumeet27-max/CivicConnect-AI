"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Complaint = require("../src/models/Complaint");
const { getAuthorityComplaintById } = require("../src/controllers/authorityController");

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

test("authority complaint detail database errors return a generic response", async () => {
    const originalFindById = Complaint.findById;
    Complaint.findById = () => ({
        select() {
            return this;
        },
        populate() {
            return this;
        },
        lean() {
            return Promise.reject(new Error("Synthetic database failure"));
        }
    });

    try {
        const response = createResponse();
        await getAuthorityComplaintById(
            { user: { role: "authority" }, params: { id: "507f1f77bcf86cd799439011" } },
            response
        );

        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, {
            success: false,
            message: "Unable to fetch complaint at this time"
        });
    } finally {
        Complaint.findById = originalFindById;
    }
});
