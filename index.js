const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    process.env.CLIENT_URL,
  ],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// server connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bfdgp2o.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

const verifyToken = (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).send({ message: "Unauthorized" });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).send({ message: "Unauthorized" });
    req.user = decoded;
    next();
  });
};

async function run() {
  try {
    await client.connect();
    const db = client.db("petAdoptionDB");
    const petsCollection = db.collection("pets");
    const requestsCollection = db.collection("adoptionRequests");
    const wishlistCollection = db.collection("wishlists");

    // AUTH
    app.post("/jwt", (req, res) => {
      const token = jwt.sign(req.body, process.env.JWT_SECRET, { expiresIn: "7d" });
      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      }).send({ success: true });
    });

    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      }).send({ success: true });
    });

    // all pets sorting
    app.get("/pets", async (req, res) => {
      try {
        const { search, species, sort } = req.query;
        let query = {};
        if (search) query.name = { $regex: search, $options: "i" };
        if (species && species !== "all") query.species = { $in: [species] };
        let sortOption = { createdAt: -1 };
        if (sort === "price_asc") sortOption = { adoptionFee: 1 };
        else if (sort === "price_desc") sortOption = { adoptionFee: -1 };
        else if (sort === "age_asc") sortOption = { age: 1 };
        else if (sort === "age_desc") sortOption = { age: -1 };
        const pets = await petsCollection.find(query).sort(sortOption).toArray();
        res.send(pets);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.get("/pets/featured", async (req, res) => {
      try {
        const pets = await petsCollection.find({ status: "available" }).sort({ createdAt: -1 }).limit(8).toArray();
        res.send(pets);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.get("/pets/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
        const pet = await petsCollection.findOne({ _id: new ObjectId(id) });
        if (!pet) return res.status(404).send({ message: "Pet not found!" });
        res.send(pet);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.get("/my-pets", verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        if (req.user.email !== email) return res.status(403).send({ message: "Forbidden" });
        const pets = await petsCollection.find({ ownerEmail: email }).sort({ createdAt: -1 }).toArray();
        res.send(pets);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.post("/pets", verifyToken, async (req, res) => {
      try {
        const pet = { ...req.body, status: "available", createdAt: new Date() };
        const result = await petsCollection.insertOne(pet);
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.put("/pets/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
        const updated = { ...req.body };
        delete updated._id;
        const result = await petsCollection.updateOne(
          { _id: new ObjectId(id), ownerEmail: req.user.email },
          { $set: updated }
        );
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.delete("/pets/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
        const result = await petsCollection.deleteOne({ _id: new ObjectId(id), ownerEmail: req.user.email });
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    // ADOPTION REQUESTS
    app.post("/requests", verifyToken, async (req, res) => {
      try {
        const requestData = req.body;
        const pet = await petsCollection.findOne({ _id: new ObjectId(requestData.petId) });
        if (!pet) return res.status(404).send({ message: "Pet not found" });
        if (pet.status === "adopted") return res.status(400).send({ message: "Pet already adopted" });
        if (pet.ownerEmail === req.user.email) return res.status(403).send({ message: "You cannot adopt your own pet" });
        const exists = await requestsCollection.findOne({ petId: requestData.petId, requesterEmail: req.user.email });
        if (exists) return res.status(400).send({ message: "You already requested this pet" });
        const result = await requestsCollection.insertOne({ ...requestData, status: "pending", requestDate: new Date() });
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.get("/requests/pet/:petId", verifyToken, async (req, res) => {
      try {
        const requests = await requestsCollection.find({ petId: req.params.petId }).toArray();
        res.send(requests);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.get("/my-requests", verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        if (req.user.email !== email) return res.status(403).send({ message: "Forbidden" });
        const requests = await requestsCollection.find({ requesterEmail: email }).sort({ requestDate: -1 }).toArray();
        res.send(requests);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.patch("/requests/:id/approve", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Give a valid ID" });
        const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
        if (!request) return res.status(404).send({ message: "Not found" });
        await requestsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: "approved" } });
        await requestsCollection.updateMany({ petId: request.petId, _id: { $ne: new ObjectId(id) } }, { $set: { status: "rejected" } });
        await petsCollection.updateOne({ _id: new ObjectId(request.petId) }, { $set: { status: "adopted" } });
        res.send({ success: true });
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.patch("/requests/:id/reject", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
        const result = await requestsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: "rejected" } });
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.delete("/requests/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
        const result = await requestsCollection.deleteOne({ _id: new ObjectId(id), requesterEmail: req.user.email });
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    // WISHLIST
    app.get("/wishlist", verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        if (req.user.email !== email) return res.status(403).send({ message: "Forbidden" });
        const items = await wishlistCollection.find({ userEmail: email }).toArray();
        res.send(items);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.post("/wishlist", verifyToken, async (req, res) => {
      try {
        const { petId, userEmail } = req.body;
        const exists = await wishlistCollection.findOne({ petId, userEmail });
        if (exists) return res.status(400).send({ message: "Already in wishlist" });
        const result = await wishlistCollection.insertOne({ ...req.body, addedAt: new Date() });
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.delete("/wishlist/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
        const result = await wishlistCollection.deleteOne({ _id: new ObjectId(id), userEmail: req.user.email });
        res.send(result);
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    app.get("/", (req, res) => res.send("Pet Adoption Server Running!"));
    console.log("MongoDB connected!");
  } catch (err) {
    console.error(err);
  }
}

run();
app.listen(port, () => console.log(`Server on port ${port}`));
