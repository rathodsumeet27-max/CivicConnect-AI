const mongoose = require("mongoose");

async function connectDatabase() {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
        throw new Error("MONGODB_URI environment variable is required");
    }

    return mongoose.connect(mongoUri);
}

module.exports = connectDatabase;
