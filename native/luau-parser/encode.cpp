// Serializes the Luau AST into compact JSON with UTF-8 byte offsets for the
// TypeScript adapter in src/luau-syntax.ts
#include "Luau/Ast.h"
#include "Luau/Common.h"
#include "Luau/ParseOptions.h"
#include "Luau/Parser.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

LUAU_FASTFLAGVARIABLE(LuauExperimentalIfLocalAnalysis)

namespace
{

    using namespace Luau;

    struct Encoder
    {
        std::string out;
        std::vector<size_t> lineOffsets;
        std::unordered_map<const AstLocal *, int> locals;

        explicit Encoder(const char *source, size_t length)
        {
            lineOffsets.push_back(0);

            for (size_t i = 0; i < length; ++i)
                if (source[i] == '\n')
                    lineOffsets.push_back(i + 1);

            out.reserve(length * 6);
        }

        size_t offset(const Position &position) const
        {
            if (position.line >= lineOffsets.size())
                return lineOffsets.back();

            return lineOffsets[position.line] + position.column;
        }

        void raw(const char *text)
        {
            out += text;
        }

        void number(size_t value)
        {
            out += std::to_string(value);
        }

        void string(const char *data, size_t length)
        {
            out += '"';

            for (size_t i = 0; i < length; ++i)
            {
                unsigned char c = static_cast<unsigned char>(data[i]);

                if (c == '"' || c == '\\')
                {
                    out += '\\';
                    out += char(c);
                }
                else if (c < 0x20)
                {
                    char buffer[8];
                    snprintf(buffer, sizeof(buffer), "\\u%04x", c);
                    out += buffer;
                }
                else
                    out += char(c);
            }

            out += '"';
        }

        void string(const std::string &value)
        {
            string(value.data(), value.size());
        }

        void name(const AstName &value)
        {
            if (value.value)
                string(value.value, strlen(value.value));
            else
                raw("null");
        }

        void range(const Location &location)
        {
            out += '[';
            number(offset(location.begin));
            out += ',';
            number(offset(location.end));
            out += ']';
        }

        void key(const char *text)
        {
            out += ",\"";
            out += text;
            out += "\":";
        }

        void begin(const char *type, const Location &location)
        {
            out += "{\"t\":\"";
            out += type;
            out += "\",\"s\":";
            number(offset(location.begin));
            out += ",\"e\":";
            number(offset(location.end));
        }

        void end()
        {
            out += '}';
        }

        int localId(const AstLocal *local)
        {
            auto found = locals.find(local);

            if (found != locals.end())
                return found->second;

            int id = int(locals.size());
            locals[local] = id;

            return id;
        }

        void local(AstLocal *value)
        {
            begin("Local", value->location);
            key("name");
            name(value->name);
            key("id");
            number(localId(value));

            if (value->annotation)
            {
                key("annotation");
                type(value->annotation);
            }

            end();
        }

        template <typename T, typename F>
        void list(const AstArray<T> &values, F &&each)
        {
            out += '[';

            for (size_t i = 0; i < values.size; ++i)
            {
                if (i)
                    out += ',';

                each(values.data[i]);
            }

            out += ']';
        }

        void exprs(const AstArray<AstExpr *> &values)
        {
            list(values, [&](AstExpr *value)
                 { expr(value); });
        }

        void stats(const AstArray<AstStat *> &values)
        {
            list(values, [&](AstStat *value)
                 { stat(value); });
        }

        void locals_(const AstArray<AstLocal *> &values)
        {
            list(values, [&](AstLocal *value)
                 { local(value); });
        }

        void typeOrPack(const AstTypeOrPack &value)
        {
            if (value.type)
                type(value.type);
            else if (value.typePack)
                typePack(value.typePack);
            else
                raw("null");
        }

        void typeList(const AstTypeList &value)
        {
            out += "{\"types\":";
            list(value.types, [&](AstType *item)
                 { type(item); });

            if (value.tailType)
            {
                key("tail");
                typePack(value.tailType);
            }

            end();
        }

        void generics(const AstArray<AstGenericType *> &types, const AstArray<AstGenericTypePack *> &packs)
        {
            if (types.size == 0 && packs.size == 0)
                return;

            key("generics");
            list(types, [&](AstGenericType *item)
                 {
            begin("GenericType", item->location);
            key("name");
            name(item->name);
            end(); });

            key("genericPacks");
            list(packs, [&](AstGenericTypePack *item)
                 {
            begin("GenericTypePack", item->location);
            key("name");
            name(item->name);
            end(); });
        }

        void function(AstExprFunction *node)
        {
            begin("Function", node->location);
            generics(node->generics, node->genericPacks);

            if (node->self)
            {
                key("self");
                local(node->self);
            }

            key("args");
            locals_(node->args);

            if (node->vararg)
            {
                key("vararg");
                range(node->varargLocation);

                if (node->varargAnnotation)
                {
                    key("varargAnnotation");
                    typePack(node->varargAnnotation);
                }
            }

            if (node->returnAnnotation)
            {
                key("returnAnnotation");
                typePack(node->returnAnnotation);
            }

            if (node->argLocation)
            {
                key("argLocation");
                range(*node->argLocation);
            }

            key("body");
            stat(node->body);
            end();
        }

        void expr(AstExpr *node)
        {
            if (!node)
            {
                raw("null");

                return;
            }

            if (auto n = node->as<AstExprGroup>())
            {
                begin("Group", n->location);
                key("expr");
                expr(n->expr);
                end();
            }
            else if (node->is<AstExprConstantNil>())
            {
                begin("Nil", node->location);
                end();
            }
            else if (auto n = node->as<AstExprConstantBool>())
            {
                begin("Bool", n->location);
                key("value");
                raw(n->value ? "true" : "false");
                end();
            }
            else if (node->is<AstExprConstantNumber>() || node->is<AstExprConstantInteger>())
            {
                begin("Number", node->location);
                end();
            }
            else if (auto n = node->as<AstExprConstantString>())
            {
                begin("String", n->location);
                end();
            }
            else if (auto n = node->as<AstExprLocal>())
            {
                begin("ExprLocal", n->location);
                key("name");
                name(n->local->name);
                key("local");
                number(localId(n->local));
                end();
            }
            else if (auto n = node->as<AstExprGlobal>())
            {
                begin("Global", n->location);
                key("name");
                name(n->name);
                end();
            }
            else if (node->is<AstExprVarargs>())
            {
                begin("Varargs", node->location);
                end();
            }
            else if (auto n = node->as<AstExprCall>())
            {
                begin("Call", n->location);
                key("func");
                expr(n->func);
                key("args");
                exprs(n->args);

                if (n->self)
                {
                    key("self");
                    raw("true");
                }

                key("argLocation");
                range(n->argLocation);
                end();
            }
            else if (auto n = node->as<AstExprIndexName>())
            {
                begin("IndexName", n->location);
                key("expr");
                expr(n->expr);
                key("index");
                name(n->index);
                key("indexLocation");
                range(n->indexLocation);
                key("op");
                out += '"';
                out += n->op;
                out += '"';
                end();
            }
            else if (auto n = node->as<AstExprIndexExpr>())
            {
                begin("IndexExpr", n->location);
                key("expr");
                expr(n->expr);
                key("index");
                expr(n->index);
                end();
            }
            else if (auto n = node->as<AstExprFunction>())
                function(n);
            else if (auto n = node->as<AstExprTable>())
            {
                begin("Table", n->location);
                key("items");
                list(n->items, [&](const AstExprTable::Item &item)
                     {
                out += "{\"kind\":";
                number(size_t(item.kind));

                if (item.key)
                {
                    key("key");
                    expr(item.key);
                }

                key("value");
                expr(item.value);
                end(); });

                end();
            }
            else if (auto n = node->as<AstExprUnary>())
            {
                begin("Unary", n->location);
                key("op");
                number(size_t(n->op));
                key("expr");
                expr(n->expr);
                end();
            }
            else if (auto n = node->as<AstExprBinary>())
            {
                begin("Binary", n->location);
                key("op");
                number(size_t(n->op));
                key("left");
                expr(n->left);
                key("right");
                expr(n->right);
                end();
            }
            else if (auto n = node->as<AstExprTypeAssertion>())
            {
                begin("Cast", n->location);
                key("expr");
                expr(n->expr);
                key("annotation");
                type(n->annotation);
                end();
            }
            else if (auto n = node->as<AstExprIfElse>())
            {
                begin("IfElse", n->location);
                key("condition");
                expr(n->condition);
                key("trueExpr");
                expr(n->hasThen ? n->trueExpr : nullptr);
                key("falseExpr");
                expr(n->hasElse ? n->falseExpr : nullptr);
                end();
            }
            else if (auto n = node->as<AstExprInterpString>())
            {
                begin("InterpString", n->location);
                key("expressions");
                exprs(n->expressions);
                end();
            }
            else if (auto n = node->as<AstExprInstantiate>())
            {
                begin("Instantiate", n->location);
                key("expr");
                expr(n->expr);
                end();
            }
            else if (auto n = node->as<AstExprError>())
            {
                begin("ExprError", n->location);
                key("expressions");
                exprs(n->expressions);
                end();
            }
            else
            {
                begin("UnknownExpr", node->location);
                end();
            }
        }

        void stat(AstStat *node)
        {
            if (!node)
            {
                raw("null");

                return;
            }

            if (auto n = node->as<AstStatBlock>())
            {
                begin("Block", n->location);
                key("body");
                stats(n->body);
                end();
            }
            else if (auto n = node->as<AstStatIf>())
            {
                begin("If", n->location);
                key("condition");
                expr(n->condition);
                key("thenbody");
                stat(n->thenbody);

                if (n->elseLocation)
                {
                    key("elseLocation");
                    range(*n->elseLocation);
                }

                key("elsebody");
                stat(n->elsebody);
                end();
            }
            else if (auto n = node->as<AstStatWhile>())
            {
                begin("While", n->location);
                key("condition");
                expr(n->condition);
                key("body");
                stat(n->body);
                end();
            }
            else if (auto n = node->as<AstStatRepeat>())
            {
                begin("Repeat", n->location);
                key("condition");
                expr(n->condition);
                key("body");
                stat(n->body);
                end();
            }
            else if (node->is<AstStatBreak>())
            {
                begin("Break", node->location);
                end();
            }
            else if (node->is<AstStatContinue>())
            {
                begin("Continue", node->location);
                end();
            }
            else if (auto n = node->as<AstStatReturn>())
            {
                begin("Return", n->location);
                key("list");
                exprs(n->list);
                end();
            }
            else if (auto n = node->as<AstStatExpr>())
            {
                begin("ExprStat", n->location);
                key("expr");
                expr(n->expr);
                end();
            }
            else if (auto n = node->as<AstStatLocal>())
            {
                begin("LocalStat", n->location);
                key("vars");
                locals_(n->vars);
                key("values");
                exprs(n->values);
                end();
            }
            else if (auto n = node->as<AstStatFor>())
            {
                begin("For", n->location);
                key("var");
                local(n->var);
                key("from");
                expr(n->from);
                key("to");
                expr(n->to);

                if (n->step)
                {
                    key("step");
                    expr(n->step);
                }

                key("body");
                stat(n->body);
                end();
            }
            else if (auto n = node->as<AstStatForIn>())
            {
                begin("ForIn", n->location);
                key("vars");
                locals_(n->vars);
                key("values");
                exprs(n->values);
                key("body");
                stat(n->body);
                end();
            }
            else if (auto n = node->as<AstStatAssign>())
            {
                begin("Assign", n->location);
                key("vars");
                exprs(n->vars);
                key("values");
                exprs(n->values);
                end();
            }
            else if (auto n = node->as<AstStatCompoundAssign>())
            {
                begin("CompoundAssign", n->location);
                key("op");
                number(size_t(n->op));
                key("var");
                expr(n->var);
                key("value");
                expr(n->value);
                end();
            }
            else if (auto n = node->as<AstStatFunction>())
            {
                begin("FunctionStat", n->location);
                key("name");
                expr(n->name);
                key("func");
                function(n->func);
                end();
            }
            else if (auto n = node->as<AstStatLocalFunction>())
            {
                begin("LocalFunction", n->location);
                key("name");
                local(n->name);
                key("func");
                function(n->func);
                end();
            }
            else if (auto n = node->as<AstStatTypeAlias>())
            {
                begin("TypeAlias", n->location);
                key("name");
                name(n->name);
                key("nameLocation");
                range(n->nameLocation);
                generics(n->generics, n->genericPacks);
                key("type");
                type(n->type);
                key("exported");
                raw(n->exported ? "true" : "false");
                end();
            }
            else if (auto n = node->as<AstStatTypeFunction>())
            {
                begin("TypeFunctionStat", n->location);
                key("name");
                name(n->name);
                key("nameLocation");
                range(n->nameLocation);
                end();
            }
            else if (node->is<AstStatDeclareGlobal>() || node->is<AstStatDeclareFunction>() || node->is<AstStatDeclareExternType>())
            {
                begin("Declare", node->location);
                end();
            }
            else if (auto n = node->as<AstStatError>())
            {
                begin("StatError", n->location);
                key("expressions");
                exprs(n->expressions);
                key("statements");
                stats(n->statements);
                end();
            }
            else
            {
                begin("UnknownStat", node->location);
                end();
            }
        }

        void typePack(AstTypePack *node)
        {
            if (!node)
            {
                raw("null");

                return;
            }

            if (auto n = node->as<AstTypePackExplicit>())
            {
                begin("TypePackExplicit", n->location);
                key("typeList");
                typeList(n->typeList);
                end();
            }
            else if (auto n = node->as<AstTypePackVariadic>())
            {
                begin("TypePackVariadic", n->location);
                key("type");
                type(n->variadicType);
                end();
            }
            else if (auto n = node->as<AstTypePackGeneric>())
            {
                begin("TypePackGeneric", n->location);
                key("name");
                name(n->genericName);
                end();
            }
            else
            {
                begin("UnknownTypePack", node->location);
                end();
            }
        }

        void type(AstType *node)
        {
            if (!node)
            {
                raw("null");

                return;
            }

            if (auto n = node->as<AstTypeReference>())
            {
                begin("TypeReference", n->location);
                key("name");
                name(n->name);

                if (n->prefix)
                {
                    key("prefix");
                    name(*n->prefix);
                }

                if (n->parameters.size)
                {
                    key("parameters");
                    list(n->parameters, [&](const AstTypeOrPack &item)
                         { typeOrPack(item); });
                }

                end();
            }
            else if (auto n = node->as<AstTypeTable>())
            {
                begin("TypeTable", n->location);
                key("props");
                list(n->props, [&](const AstTableProp &item)
                     {
                out += "{\"name\":";
                name(item.name);
                key("location");
                range(item.location);
                key("type");
                type(item.type);
                end(); });

                if (n->indexer)
                {
                    key("indexer");
                    out += "{\"location\":";
                    range(n->indexer->location);
                    key("indexType");
                    type(n->indexer->indexType);
                    key("resultType");
                    type(n->indexer->resultType);
                    end();
                }

                end();
            }
            else if (auto n = node->as<AstTypeFunction>())
            {
                begin("TypeFunction", n->location);
                generics(n->generics, n->genericPacks);
                key("argTypes");
                typeList(n->argTypes);
                key("argNames");
                list(n->argNames, [&](const std::optional<AstArgumentName> &item)
                     {
                if (!item)
                {
                    raw("null");

                    return;
                }

                out += "{\"name\":";
                name(item->first);
                key("location");
                range(item->second);
                end(); });

                key("returnTypes");
                typePack(n->returnTypes);
                end();
            }
            else if (auto n = node->as<AstTypeTypeof>())
            {
                begin("TypeTypeof", n->location);
                end();
            }
            else if (auto n = node->as<AstTypeUnion>())
            {
                begin("TypeUnion", n->location);
                key("types");
                list(n->types, [&](AstType *item)
                     { type(item); });
                end();
            }
            else if (auto n = node->as<AstTypeIntersection>())
            {
                begin("TypeIntersection", n->location);
                key("types");
                list(n->types, [&](AstType *item)
                     { type(item); });
                end();
            }
            else if (node->is<AstTypeOptional>())
            {
                begin("TypeOptional", node->location);
                end();
            }
            else if (auto n = node->as<AstTypeSingletonBool>())
            {
                begin("TypeSingletonBool", n->location);
                end();
            }
            else if (node->is<AstTypeSingletonString>())
            {
                begin("TypeSingletonString", node->location);
                end();
            }
            else if (auto n = node->as<AstTypeGroup>())
            {
                begin("TypeGroup", n->location);
                key("type");
                type(n->type);
                end();
            }
            else if (auto n = node->as<AstTypeError>())
            {
                begin("TypeError", n->location);
                key("types");
                list(n->types, [&](AstType *item)
                     { type(item); });
                end();
            }
            else
            {
                begin("UnknownType", node->location);
                end();
            }
        }
    };

    std::string result;

    // Enables every shipped Luau flag, leaving experimental and debug syntax off
    void enableFlags()
    {
        for (FValue<bool> *flag = FValue<bool>::list; flag; flag = flag->next)
        {
            if (strncmp(flag->name, "Luau", 4) != 0 || strstr(flag->name, "Experimental"))
                continue;

            flag->value = true;
        }
    }

} // namespace

extern "C"
{

    void *luau_alloc(size_t size)
    {
        return malloc(size);
    }

    void luau_free(void *pointer)
    {
        free(pointer);
    }

    // Returns a NUL-terminated JSON document owned by the module until the next call
    const char *luau_parse(const char *source, size_t length)
    {
        static bool initialized = false;

        if (!initialized)
        {
            enableFlags();
            initialized = true;
        }

        Allocator allocator;
        AstNameTable names(allocator);
        ParseOptions options;
        options.captureComments = true;
        options.allowDeclarationSyntax = true;

        ParseResult parsed = Parser::parse(source, length, names, allocator, options);

        Encoder encoder(source, length);
        encoder.raw("{\"root\":");
        encoder.stat(parsed.root);
        encoder.raw(",\"errors\":[");

        for (size_t i = 0; i < parsed.errors.size(); ++i)
        {
            if (i)
                encoder.raw(",");

            encoder.raw("{\"range\":");
            encoder.range(parsed.errors[i].getLocation());
            encoder.key("message");
            encoder.string(parsed.errors[i].getMessage());
            encoder.end();
        }

        encoder.raw("],\"comments\":[");

        for (size_t i = 0; i < parsed.commentLocations.size(); ++i)
        {
            if (i)
                encoder.raw(",");

            encoder.range(parsed.commentLocations[i].location);
        }

        encoder.raw("]}");

        result = std::move(encoder.out);

        return result.c_str();
    }
}
