const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../utils/logger');

const STEP_API_BASE = 'https://api.stepfun.com/v1';

function getApiKey() {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') {
    return null;
  }
  return key;
}

/**
 * RAG 检索 - 基于知识库的对话补全
 * POST /api/chat
 * Body: {
 *   vector_store_id: string,      // 知识库 ID
 *   messages: [{ role, content }], // 完整对话历史（多轮对话，最后一条是当前问题）
 *   model?: string,                // 模型名称，默认 step-3.7-flash
 *   system_prompt?: string,        // 系统提示词
 *   kb_description?: string,       // 知识库描述（用于 retrieval tool 的 description）
 *   prompt_template?: string,      // 检索模板
 *   temperature?: number,          // 温度
 *   stream?: boolean               // 是否流式
 * }
 *
 * POST /api/chat?debug=1  — 非流式模式，返回完整响应（含 tool_calls），用于调试
 */
router.post('/', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('CHAT', 'RAG 检索失败: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  const {
    vector_store_id,
    messages: clientMessages,
    query, // 兼容旧版单条消息
    model = 'step-3.7-flash',
    system_prompt,
    kb_description = '知识库文档',
    prompt_template = '从文档 {{knowledge}} 中找到问题 {{query}} 的答案。根据文档内容中的语句找到答案，如果文档中没有答案则告诉用户找不到相关信息。',
    temperature = 0.5,
    stream = true
  } = req.body;

  if (!vector_store_id) {
    return res.status(400).json({ error: '缺少 vector_store_id 参数' });
  }

  // 默认系统提示词 — 强调必须基于知识库回答
  const sysPrompt = system_prompt || `你是一个专业的知识库助手。请严格遵循以下规则：

1. **必须基于知识库回答**：所有回答必须基于知识库中检索到的内容，不要凭空编造或依赖你已有的训练数据。
2. **整理而非搬运**：理解用户的问题，从知识库中提炼、组织相关信息，用清晰、友好的方式回答。
3. **回答格式**：使用 markdown 格式让内容更易理解。
4. **诚实告知**：如果知识库中没有相关信息，明确告诉用户"知识库中未找到相关信息"。
5. **多轮对话**：记住之前的对话内容，结合上下文回答用户的后续问题。`;

  // 构造消息数组：优先使用客户端传来的完整历史，否则降级为 [system, user(query)]
  let messages = [];
  if (Array.isArray(clientMessages) && clientMessages.length > 0) {
    messages = [{ role: 'system', content: sysPrompt }, ...clientMessages];
  } else if (query) {
    messages = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: query }
    ];
  } else {
    return res.status(400).json({ error: '缺少 messages 或 query 参数' });
  }

  const lastMsg = messages[messages.length - 1];
  const lastContent = lastMsg?.content || '';
  logger.info('CHAT', `RAG 检索: kb_id="${vector_store_id}", model="${model}", turns=${messages.length - 1}, last_query="${lastContent.substring(0, 80)}${lastContent.length > 80 ? '...' : ''}", stream=${stream}`);

  // 构建 StepFun chat completions 请求体
  // 官方文档示例：tools 中的 type=retrieval，function.description 必须清晰描述知识库内容
  const body = {
    model,
    messages,
    tools: [
      {
        type: 'retrieval',
        function: {
          name: 'knowledge_base',
          description: kb_description,
          options: {
            vector_store_id,
            prompt_template
          }
        }
      }
    ],
    tool_choice: 'auto',
    temperature,
    stream
  };

  // 打印完整的请求体（用于调试 retrieval 是否配置正确）
  logger.info('CHAT', '发送给 StepFun 的请求体:', {
    model: body.model,
    messages_count: body.messages.length,
    tools: body.tools,
    tool_choice: body.tool_choice,
    temperature: body.temperature,
    stream: body.stream
  });

  try {
    const response = await fetch(`${STEP_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      let errData;
      try { errData = JSON.parse(errText); } catch { errData = { error: { message: errText } }; }
      logger.error('CHAT', `RAG 检索失败 [${response.status}]`, errData);
      return res.status(response.status).json(errData);
    }

    if (stream) {
      // 流式响应 - 透传 SSE（node-fetch 返回 Node.js Stream）
      logger.info('CHAT', 'RAG 检索流式响应开始');
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      let chunkCount = 0;
      let firstChunkLogged = false;
      let fullContent = '';

      // 解析 KB 中"未找到"的标志词
      const notFoundPatterns = [
        '未找到相关', '未找到', '没有找到', '无法找到', '找不到相关',
        '知识库中没', '知识库中没有', '知识库里没有', '知识库并未',
        '未在知识库', '无法根据', '未能找到'
      ];

      response.body.on('data', (chunk) => {
        // 透传给客户端
        res.write(chunk);

        // 调试：解析 SSE 数据，检测 KB 检索效果
        const text = chunk.toString('utf8');
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            chunkCount++;
            const delta = json.choices?.[0]?.delta;

            // 记录第一个 chunk 的完整结构（用于调试）
            if (chunkCount === 1) {
              logger.info('CHAT', `[SSE] 第一个 chunk 结构:`, JSON.stringify(json.choices?.[0]));
              firstChunkLogged = true;
            }

            if (delta?.content) {
              fullContent += delta.content;
            }
          } catch (e) {
            // 忽略 JSON 解析错误
          }
        }
      });

      response.body.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();

        // 智能判断：StepFun retrieval 是服务端自动注入上下文，不会返回 tool_calls
        // 通过 AI 回答里有没有"未找到"等关键词判断检索效果
        const hasNotFound = notFoundPatterns.some(p => fullContent.includes(p));
        logger.info('CHAT', `RAG 检索流式响应完成: chunks=${chunkCount}, content_length=${fullContent.length}, has_not_found_keyword=${hasNotFound}`);

        if (hasNotFound) {
          logger.warn('CHAT', `⚠️ AI 回答包含"未找到"关键词 — 可能 KB 中无相关内容，或用户问题与 KB 内容匹配度低`);
        } else {
          logger.info('CHAT', `✓ AI 回答正常 — 检索成功（RAG 服务端自动注入上下文，不会产生 tool_calls）`);
        }
      });

      response.body.on('error', (streamErr) => {
        logger.error('CHAT', `流式响应异常: ${streamErr.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: streamErr.message });
        } else {
          res.end();
        }
      });

      // 客户端断开连接时清理
      req.on('close', () => {
        if (response.body) response.body.destroy();
      });
    } else {
      // 非流式响应
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      const toolCalls = data.choices?.[0]?.message?.tool_calls;
      const usage = data.usage || {};

      // StepFun retrieval 是服务端自动注入，不会返回 tool_calls
      const hasNotFound = !content || /未找到相关|未找到|没有找到|无法找到|找不到相关|知识库中没|知识库中没有/.test(content);
      logger.info('CHAT', `RAG 检索成功: tokens=${usage.total_tokens || 'N/A'}, content_length=${content.length}, has_tool_calls=${!!toolCalls}（注：StepFun retrieval 服务端注入，不会返回 tool_calls）, has_not_found_keyword=${hasNotFound}`);

      logger.info('CHAT', `完整响应:`, JSON.stringify(data));
      res.json(data);
    }
  } catch (err) {
    logger.error('CHAT', `RAG 检索异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
