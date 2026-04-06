# Upgrade Plan: AdHash Dashboard (20260406102925)

- **Generated**: 2026-04-06 10:29 AM
- **HEAD Branch**: master
- **HEAD Commit ID**: b73f398

## Available Tools

**JDKs**
- JDK 21.0.7: `C:\Program Files\Java\jdk-21\bin` (current JAVA_HOME, used for Step 2 baseline)
- JDK 25: **<TO_BE_INSTALLED>** (required by Steps 3, 4, and 5)

**Build Tools**
- Maven 3.9.12: `C:\Users\Adhash Tech\.maven\maven-3.9.12\bin` (available; current)
- Maven 4.0.0: **<TO_BE_INSTALLED>** (Maven 4.0+ required for Java 25; used from Step 3 onward)
- No Maven wrapper present in either project

## Guidelines

> Note: You can add any specific guidelines or constraints for the upgrade process here if needed, bullet points are preferred.

## Options

- Working branch: appmod/java-upgrade-20260406102925
- Run tests before and after the upgrade: true

## Upgrade Goals

- Upgrade Java from 11 (AdHash-API-Test) / 21 (AdHash-Projects-Certificate-Expiry-Test) to **25** (latest LTS)

### Technology Stack

**AdHash-API-Test** (Java 11 → 25)

| Technology/Dependency | Current | Min Compatible | Why Incompatible |
| --------------------- | ------- | -------------- | ---------------- |
| Java | 11 | 25 | User requested |
| Maven | 3.x (IntelliJ) | 4.0.0 | Maven 4.0+ required for Java 25 |
| maven-compiler-plugin | 3.11.0 (source/target 11) | 3.11.0 (source/target 25) | Source/target must be updated to 25 |
| maven-surefire-plugin | 3.0.0 | 3.2.0 | 3.0.x has known issues with Java 21+ fork mode |
| TestNG ⚠️ EOL | 7.4.0 | 7.9.0 | 7.4.0 predates Java 25; byte-code issues possible; 7.4.0 unsupported |
| Lombok | 1.18.30 | 1.18.34 | Java 25 byte-code support added in 1.18.34 |
| apache/poi-ooxml | 4.1.2 | 5.2.5 | 4.x uses internal JDK APIs removed/restricted in Java 25 |
| rest-assured | 4.4.0 | 5.3.2 | 4.x uses Groovy internals incompatible with Java 25 module restrictions |
| commons-io ⚠️ EOL | 2.9.0 | 2.15.0 | 2.9.0 is EOL; security-impacting bugs fixed in newer versions |
| gson | 2.8.9 | 2.10.1 | 2.8.x has known reflection issues with Java 25 strong encapsulation |
| jackson (transitive) | varies | 2.15+ | Older Jackson versions fail under Java 25 strict module rules |

**AdHash-Projects-Certificate-Expiry-Test** (Java 21 → 25)

| Technology/Dependency | Current | Min Compatible | Why Incompatible |
| --------------------- | ------- | -------------- | ---------------- |
| Java | 21 | 25 | User requested |
| Maven | 3.x (IntelliJ) | 4.0.0 | Maven 4.0+ required for Java 25 |
| maven-compiler-plugin (implicit) | — | 3.13.0 | Must explicitly declare with source/target 25 |
| maven-surefire-plugin | 3.0.0 | 3.2.0 | Recommended upgrade for Java 21+ |

### Derived Upgrades

- Upgrade maven-compiler-plugin source/target to 25 in AdHash-API-Test (Java 25 requires it)
- Upgrade maven-surefire-plugin from 3.0.0 to 3.2.0 in both projects (Java 21+ compatibility)
- Install Maven 4.0.0 (Maven 3.9.x does not officially support Java 25)
- Install JDK 25 (target runtime, not currently installed)
- Upgrade TestNG from 7.4.0 to 7.10.2 in AdHash-API-Test (Java 25 bytecode support)
- Upgrade Lombok from 1.18.30 to 1.18.36 in AdHash-API-Test (Java 25 annotation processing support)
- Upgrade poi-ooxml from 4.1.2 to 5.2.5 in AdHash-API-Test (removes dependency on restricted internal JDK APIs)
- Upgrade rest-assured from 4.4.0 to 5.3.2 in AdHash-API-Test (Java 25 module system compatibility)
- Upgrade commons-io from 2.9.0 to 2.16.1 in AdHash-API-Test (EOL security fix + Java 25 compat)
- Upgrade gson from 2.8.9 to 2.10.1 in AdHash-API-Test (strong encapsulation compatibility)

## Upgrade Steps

- **Step 1: Setup Environment**
  - **Rationale**: Install JDK 25 (target runtime) and Maven 4.0.0 (required for Java 25 compatibility) since neither is currently available on the system.
  - **Changes to Make**:
    - [ ] Install JDK 25 via `#appmod-install-jdk version=25`
    - [ ] Install Maven 4.0.0 via `#appmod-install-maven version=4.0.0`
    - [ ] Verify both tools are accessible and record paths
  - **Verification**:
    - Command: `#appmod-list-jdks` and `#appmod-list-mavens` to confirm installations
    - Expected: JDK 25 and Maven 4.0.0 available at valid paths

---

- **Step 2: Setup Baseline**
  - **Rationale**: Record pre-upgrade compile/test results for both projects to establish acceptance criteria.
  - **Changes to Make**:
    - [ ] Run baseline compile + test for `AdHash-Projects-Certificate-Expiry-Test` (Java 21)
    - [ ] Run baseline compile + test for `AdHash-API-Test` (Java 11)
    - [ ] Document pass/fail counts and any pre-existing failures
  - **Verification**:
    - Command (cert project): `mvn clean test-compile -q -f AdHash-Projects-Certificate-Expiry-Test/pom.xml` then `mvn clean test -f AdHash-Projects-Certificate-Expiry-Test/pom.xml`
    - Command (api test): `mvn clean test-compile -q -f AdHash-API-Test/pom.xml` then `mvn clean test -f AdHash-API-Test/pom.xml`
    - JDK: `C:\Program Files\Java\jdk-21\bin` (current JAVA_HOME)
    - Expected: Document SUCCESS/FAILURE and test counts

---

- **Step 3: Upgrade AdHash-Projects-Certificate-Expiry-Test to Java 25**
  - **Rationale**: Simpler upgrade (Java 21 → 25, fewer deps). Upgrade first to validate toolchain before tackling the more complex project.
  - **Changes to Make**:
    - [ ] Update `maven.compiler.source` and `maven.compiler.target` from `21` to `25`
    - [ ] Add explicit `maven-compiler-plugin 3.13.0` with source/target 25
    - [ ] Upgrade `maven-surefire-plugin` from `3.0.0` to `3.2.0`
    - [ ] Apply same changes to `AdHash-Projects-Certificate-Expiry-Test-verify/pom.xml`
  - **Verification**:
    - Command: `mvn clean test-compile -q -f AdHash-Projects-Certificate-Expiry-Test/pom.xml`
    - JDK: JDK 25 (installed in Step 1)
    - Maven: Maven 4.0.0 (installed in Step 1)
    - Expected: Compilation SUCCESS (test failures acceptable at this stage)

---

- **Step 4: Upgrade AdHash-API-Test to Java 25**
  - **Rationale**: More complex upgrade (Java 11 → 25). Upgrade core Java version and all incompatible dependencies.
  - **Changes to Make**:
    - [ ] Update `java.version`, `maven.compiler.source`, `maven.compiler.target` from `11` to `25`; update `maven-compiler-plugin` configuration to source/target 25
    - [ ] Upgrade `testng` 7.4.0 → 7.10.2, `lombok` 1.18.30 → 1.18.36, `poi-ooxml` 4.1.2 → 5.2.5
    - [ ] Upgrade `rest-assured` 4.4.0 → 5.3.2, `commons-io` 2.9.0 → 2.16.1, `gson` 2.8.9 → 2.10.1
    - [ ] Upgrade `maven-surefire-plugin` from `3.0.0` to `3.2.0`
    - [ ] Apply same changes to `AdHash-API-Test-temp/pom.xml`
  - **Verification**:
    - Command: `mvn clean test-compile -q -f AdHash-API-Test/pom.xml`
    - JDK: JDK 25 (installed in Step 1)
    - Maven: Maven 4.0.0 (installed in Step 1)
    - Expected: Compilation SUCCESS (test failures acceptable at this stage)

---

- **Step 5: Final Validation**
  - **Rationale**: Verify all upgrade goals are met, all projects compile cleanly, and full test suites pass with Java 25.
  - **Changes to Make**:
    - [ ] Verify Java 25 source/target in all four `pom.xml` files
    - [ ] Resolve any TODOs left from Steps 3/4
    - [ ] Fix remaining compilation errors (if any)
    - [ ] Run full test suite for both projects and fix ALL test failures (iterative loop until 100% pass)
  - **Verification**:
    - Command: `mvn clean test -f AdHash-Projects-Certificate-Expiry-Test/pom.xml` and `mvn clean test -f AdHash-API-Test/pom.xml`
    - JDK: JDK 25
    - Maven: Maven 4.0.0
    - Expected: Compilation SUCCESS + 100% tests pass (≥ baseline pass rate)

## Key Challenges

- **Java 11 → 25 Large Version Jump (AdHash-API-Test)**
  - **Challenge**: Skipping two LTS versions (11→17→21→25) means cumulative breaking changes: stronger encapsulation, removed APIs, module system enforcement. Multiple dependencies need simultaneous upgrades.
  - **Strategy**: Upgrade all incompatible deps in one focused step (Step 4). Use `--add-opens` JVM args as last resort if reflective access is blocked. Prioritize compatible successor versions over workarounds.

- **Byte-Code Manipulation Libraries (Lombok, TestNG) with Java 25**
  - **Challenge**: Lombok (annotation processor), TestNG (bytecode manipulation), and POI (internal JDK API use) are sensitive to JDK internals changes between major versions.
  - **Strategy**: Upgrade to the latest stable versions that officially declare Java 25 support. Test compilation early in Step 4 and fix any annotation processing failures before running tests.

- **rest-assured 4.x → 5.x API Changes**
  - **Challenge**: rest-assured 5.x introduced minor API changes from 4.x (some static imports moved). Test sources may need minor updates.
  - **Strategy**: Compile test classes in Step 4 to surface import errors immediately. Fix import paths as needed.

- **Maven 4.0 Availability**
  - **Challenge**: Maven 4.0.0 may not be available via `#appmod-install-maven`. If installation fails, fallback to Maven 3.9.12 (which can still compile Java 25 code with maven-compiler-plugin 3.13+, just without official Maven 4.0 guarantees).
  - **Strategy**: Attempt Maven 4.0 installation; document the fallback clearly if unsuccessful.
