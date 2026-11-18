"use strict";

const mongoose = require("mongoose");
const User = require("../models/User");

async function requireCurrentAdmin(req, res, next) {
    if (!req.user || !mongoose.isObjectIdOrHexString(req.user.id)) {
        return res.status(401).json({
            success: false,
            message: "Authentication required or token is invalid"
        });
    }

    try {
        const user = await User.findById(req.user.id).select("role").lean();

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required or token is invalid"
            });
        }

        if (user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Only current admin users can access this resource"
            });
        }

        return next();
    } catch (error) {
        console.error("Verifying current admin access failed unexpectedly.");
        return res.status(500).json({
            success: false,
            message: "Unable to verify administrator access at this time"
        });
    }
}

module.exports = requireCurrentAdmin;
