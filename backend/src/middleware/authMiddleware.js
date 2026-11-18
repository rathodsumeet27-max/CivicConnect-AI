const jwt = require("jsonwebtoken");

const validRoles = ["citizen", "authority", "worker", "admin"];
const unauthorizedResponse = {
    success: false,
    message: "Authentication required or token is invalid"
};

function authMiddleware(req, res, next) {
    const authorization = req.get("authorization");
    const bearerMatch = typeof authorization === "string"
        ? authorization.trim().match(/^Bearer\s+(\S+)$/i)
        : null;

    if (!bearerMatch) {
        return res.status(401).json(unauthorizedResponse);
    }

    let payload;

    try {
        payload = jwt.verify(bearerMatch[1], process.env.JWT_SECRET, {
            algorithms: ["HS256"],
            issuer: "civicconnect-ai",
            audience: "civicconnect-ai-api"
        });
    } catch {
        return res.status(401).json(unauthorizedResponse);
    }

    if (
        payload === null
        || typeof payload !== "object"
        || typeof payload.sub !== "string"
        || payload.sub.length === 0
        || !validRoles.includes(payload.role)
        || !Number.isInteger(payload.exp)
    ) {
        return res.status(401).json(unauthorizedResponse);
    }

    req.user = {
        id: payload.sub,
        role: payload.role
    };

    return next();
}

module.exports = authMiddleware;
