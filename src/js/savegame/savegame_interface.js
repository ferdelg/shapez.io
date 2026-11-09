import { createLogger } from "../core/logging";

const Ajv = require("ajv");
const ajv = new Ajv({
    allErrors: false,
    uniqueItems: false,
    unicode: false,
    nullable: false,
});

const validators = {};

const logger = createLogger("savegame_interface");

export class BaseSavegameInterface {
    /**
     * Returns the interfaces version
     */
    getVersion() {
        throw new Error("Implement get version");
    }

    /**
     * Returns the uncached json schema
     * @returns {object}
     */
    getSchemaUncached() {
        throw new Error("Implement get schema");
    }

    getValidator() {
        const version = this.getVersion();
        if (validators[version]) {
            return validators[version];
        }
        logger.log("Compiling schema for savegame version", version);
        const schema = this.getSchemaUncached();
        if (G_IS_FLINSH) {
            // Ajv compiles schemas with new Function(), which the Flinsh CSP (no 'unsafe-eval')
            // refuses, so saving would fail. Every savegame schema (schemas/*.json) is just
            // { type: "object", required: [], additionalProperties: true }; check exactly that.
            const isPlainObjectSchema =
                schema &&
                schema.type === "object" &&
                (!schema.required || schema.required.length === 0) &&
                schema.additionalProperties !== false &&
                !schema.properties;
            if (!isPlainObjectSchema) {
                throw new Error(
                    "Savegame schema " + version + " needs Ajv, which can't run under the Flinsh CSP"
                );
            }
            /** @type {((data: any) => boolean) & { errors?: object[] | null }} */
            const validator = data => {
                const ok = data !== null && typeof data === "object" && !Array.isArray(data);
                validator.errors = ok
                    ? null
                    : [{ keyword: "type", dataPath: "", message: "should be object" }];
                return ok;
            };
            validators[version] = validator;
            return validator;
        }
        try {
            validators[version] = ajv.compile(schema);
        } catch (ex) {
            logger.error("SCHEMA FOR", this.getVersion(), "IS INVALID!");
            logger.error(ex);
            throw new Error("Invalid schema for version " + version);
        }
        return validators[version];
    }

    /**
     * Constructs an new interface for the given savegame
     * @param {any} data
     */
    constructor(data) {
        this.data = data;
    }

    /**
     * Validates the data
     * @returns {boolean}
     */
    validate() {
        const validator = this.getValidator();

        if (!validator(this.data)) {
            logger.error(
                "Savegame failed validation! ErrorText:",
                ajv.errorsText(validator.errors),
                "RawErrors:",
                validator.errors
            );
            return false;
        }

        return true;
    }

    ///// INTERFACE (Override when the schema changes) /////

    /**
     * Returns the time of last update
     * @returns {number}
     */
    readLastUpdate() {
        return this.data.lastUpdate;
    }

    /**
     * Returns the ingame time in seconds
     * @returns {number}
     */
    readIngameTimeSeconds() {
        return this.data.dump.time.timeSeconds;
    }
}
