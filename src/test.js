const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://mesa-iptv:Sindirbos789@iptv-cluster.tfvtcrs.mongodb.net/?retryWrites=true&w=majority&appName=iptv-cluster";

const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000
});

async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB!");
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Ping successful!");
  } catch (err) {
    console.error("❌ Connection failed:", err.message);
  } finally {
    await client.close();
  }
}
run().catch(console.dir);