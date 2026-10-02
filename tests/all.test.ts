process.env.NODE_ENV = "test";

import "./auth/jwt.test.js";
import "./auth/oauth.test.js";
import "./auth/endpoint.test.js";
import "./pep/firewall.test.js";
import "./pep/masking.test.js";
import "./pep/admin-procedures.test.js";
import "./catalog/catalog.test.js";
import "./secrets/local.test.js";
